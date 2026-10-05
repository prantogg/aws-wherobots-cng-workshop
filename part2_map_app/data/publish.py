#!/usr/bin/env python3
"""Copy an export run from Wherobots managed storage to the public app bucket.

    set -a; source .env; set +a                        # WHEROBOTS_API_KEY
    AWS_PROFILE=<profile> .venv/bin/python part2_map_app/data/publish.py <version> [--as <published>] [--carry-tiles <old>] [--dry-run]

Needs `pip install pmtiles` (maintainers only; participants never run this). Reads
<managed>/cng-app/v<version>/ (written by export_sd_app_data.py), uploads its tiles to
s3://<bucket>/sd/v<version>/tiles/*.pmtiles and copies app/hexes.json and app/places.json next
to index.html. --as publishes the run under another version (exports are stamped with the
day they ran, which may already be taken). --carry-tiles <old> copies any tile file it did not produce from v<old>
(server-side). Versions are immutable: an existing tile set for <version> stops the run. The
Wherobots API key is only ever sent to the Wherobots API; download redirects are followed
without it.
"""
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import boto3
import gzip as _gzip
from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, zxy_to_tileid
from pmtiles.writer import Writer

API = "https://api.cloud.wherobots.com"
BUCKET = os.environ.get("APP_BUCKET", "wherobots-cng-workshop-sd-uw2")
REGION = "us-west-2"
APP_DIR = Path(__file__).resolve().parent.parent
KEY = os.environ["WHEROBOTS_API_KEY"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_no_redirect = urllib.request.build_opener(NoRedirect)


def api(path, query=None):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def managed():
    st = api("/storage")
    st = st if isinstance(st, list) else st.get("items") or []
    m = next(i for i in st if i.get("type") == "MANAGED")
    return m["id"], (m.get("defaultDirectory") or "").strip("/")


def list_files(storage_id, path):
    """Every file under `path`, recursively, as paths relative to it."""
    out, stack = [], [""]
    while stack:
        rel = stack.pop()
        q = urllib.parse.quote(f"{path}/{rel}".rstrip("/") + "/", safe="")
        cursor = None
        while True:
            listing = api(f"/storage/{storage_id}/directories/{q}", {"cursor": cursor} if cursor else None)
            for item in listing.get("items") or []:
                child = rel + item["name"].rstrip("/")
                if item.get("type") == "FILE":
                    out.append(child)
                else:
                    stack.append(child + "/")
            cursor = listing.get("next_page")
            if not cursor:
                break
    return sorted(out)


def download(storage_id, path, dest):
    q = urllib.parse.quote(path, safe="")
    req = urllib.request.Request(f"{API}/storage/{storage_id}/files/{q}", headers={"X-API-Key": KEY})
    try:
        _no_redirect.open(req, timeout=60)
        raise RuntimeError(f"expected a redirect for {path}")
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        signed = e.headers["Location"]
    with urllib.request.urlopen(signed, timeout=600) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def gzip_tiles(path):
    """Rewrite a PMTiles archive with gzip-compressed tiles if it has none (wherobots.vtiles
    writes uncompressed tiles; gzip cuts the county view's download about 5x). Returns the
    path to upload."""
    with open(path, "rb") as f:
        r = Reader(MmapSource(f))
        header, metadata = r.header(), r.metadata()
        if header["tile_compression"] != Compression.NONE:
            return path
        out = str(path) + ".gz.pmtiles"
        with open(out, "wb") as o:
            w = Writer(o)
            for (z, x, y), data in all_tiles(r.get_bytes):
                w.write_tile(zxy_to_tileid(z, x, y), _gzip.compress(data, 6))
            header["tile_compression"] = Compression.GZIP
            w.finalize(header, metadata)
    return out


def content_type(name):
    return "application/json" if name.endswith(".json") else "application/octet-stream"


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    carry = argv[argv.index("--carry-tiles") + 1] if "--carry-tiles" in argv else None
    alias = argv[argv.index("--as") + 1] if "--as" in argv else None
    source = [a for a in argv if not a.startswith("--") and a not in (carry, alias)][0]
    version = alias or source
    storage_id, default_dir = managed()
    root = f"/{default_dir}/cng-app/v{source}"
    files = list_files(storage_id, root)
    print(f"{len(files)} files under {root}")

    s3 = boto3.client("s3", region_name=REGION)
    guard = f"sd/v{version}/tiles/" + next(f for f in files if f.startswith("tiles/"))[len("tiles/"):]
    try:
        s3.head_object(Bucket=BUCKET, Key=guard)
        sys.exit(f"version {version} is already published; versions are immutable")
    except s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchKey", "403"):
            raise

    plan = []
    for f in files:
        if f.startswith("tiles/"):
            plan.append((f, f"sd/v{version}/{f}"))
        elif f.startswith("app/"):
            plan.append((f, None))
    carried = []
    if carry:
        have = {f[len("tiles/"):] for f in files if f.startswith("tiles/")}
        old = s3.list_objects_v2(Bucket=BUCKET, Prefix=f"sd/v{carry}/tiles/").get("Contents", [])
        carried = [o["Key"] for o in old if o["Key"].rsplit("/", 1)[-1] not in have]
    for src, dst in plan:
        print(f"  {src} -> {dst or 'part2_map_app/' + Path(src).name}")
    for k in carried:
        print(f"  (copy) {k} -> sd/v{version}/tiles/{k.rsplit('/', 1)[-1]}")
    if dry:
        return

    with tempfile.TemporaryDirectory() as tmp:
        for src, dst in plan:
            local = Path(tmp) / src.replace("/", "_")
            download(storage_id, f"{root}/{src}", local)
            if dst is None:
                (APP_DIR / Path(src).name).write_bytes(local.read_bytes())
            else:
                up = gzip_tiles(local) if dst.endswith(".pmtiles") else str(local)
                s3.upload_file(up, BUCKET, dst, ExtraArgs={"ContentType": content_type(dst)})
                if up != str(local):
                    print(f"  gzipped {Path(src).name}: {local.stat().st_size/1e6:.0f} MB -> {Path(up).stat().st_size/1e6:.0f} MB")
                    Path(up).unlink()
            local.unlink()
    for k in carried:
        s3.copy_object(Bucket=BUCKET, Key=f"sd/v{version}/tiles/{k.rsplit('/', 1)[-1]}",
                       CopySource={"Bucket": BUCKET, "Key": k})
    print(f"published v{version} to s3://{BUCKET}/sd/")


if __name__ == "__main__":
    main()
