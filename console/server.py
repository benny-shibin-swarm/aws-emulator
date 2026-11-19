"""Loopback companion for the AWS Emulator S3 console."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

MAX_UPLOAD = 64 * 1024 * 1024
BUCKET = re.compile(r"[A-Za-z0-9_.-]{3,255}")
REGION = re.compile(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+")

S3_ERRORS = {
    "AccessDenied": (403, "Access denied for this S3 operation."),
    "BucketAlreadyExists": (409, "This bucket name is already in use. Choose a different name."),
    "BucketAlreadyOwnedByYou": (409, "You already own a bucket with this name."),
    "BucketNotEmpty": (409, "Delete all objects, object versions, and delete markers before deleting this bucket."),
    "InvalidBucketName": (400, "The bucket name is invalid."),
    "InvalidLocationConstraint": (400, "The specified bucket region is invalid."),
    "IllegalLocationConstraintException": (400, "The bucket region does not match the request region."),
    "NoSuchBucket": (404, "The specified bucket does not exist."),
    "NoSuchKey": (404, "The specified object does not exist."),
    "NoSuchVersion": (404, "The specified object version does not exist."),
    "PreconditionFailed": (412, "The object no longer meets the conditions for this operation."),
    "MethodNotAllowed": (405, "This operation is not allowed for the selected resource."),
    "NotImplemented": (501, "This operation is not implemented by the emulator."),
    "SlowDown": (503, "S3 is throttling requests. Try again shortly."),
}

ASSETS = {
    "/": ("index.html", "text/html"),
    "/console.css": ("console.css", "text/css"),
    "/console.js": ("console.js", "text/javascript"),
}


class ConsoleHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json_response(self, status, value):
        self.respond(status, "application/json", json.dumps(value).encode())

    def do_GET(self):
        if (self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self.json_response(403, {"error": "Open the console at its local address."})
            return

        url = urlsplit(self.path)
        if url.path in ASSETS:
            name, content_type = ASSETS[url.path]
            self.respond(200, content_type, Path(__file__).with_name(name).read_bytes())
            return

        config = self.server.config
        if url.path == "/api/health":
            try:
                connection = http.client.HTTPSConnection(
                    "127.0.0.1", config.emulator_port, timeout=3,
                    context=ssl.create_default_context(cafile=str(config.ca_bundle)),
                )
                try:
                    connection.request("GET", "/__admin/health")
                    ready = connection.getresponse().status == 200
                finally:
                    connection.close()
            except (OSError, http.client.HTTPException):
                ready = False
            self.json_response(200, {"endpoint": config.endpoint, "ready": ready})
            return

        if url.path not in ("/api/buckets", "/api/objects", "/api/download"):
            self.json_response(404, {"error": "Page not found."})
            return

        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        region = query.get("region", "us-east-1")
        if not REGION.fullmatch(region):
            self.json_response(400, {"error": "Enter a valid AWS region."})
            return
        if url.path == "/api/buckets":
            operation = "list-buckets"
            arguments = {"MaxBuckets": 100}
        else:
            bucket = query.get("bucket", "")
            if not BUCKET.fullmatch(bucket):
                self.json_response(400, {"error": "Invalid bucket name."})
                return
            if url.path == "/api/download":
                self.transfer_object(query, region)
                return
            operation = "list-objects-v2"
            arguments = {"Bucket": bucket, "Delimiter": "/", "MaxKeys": 100}
            if "prefix" in query:
                arguments["Prefix"] = query["prefix"]
        if "token" in query:
            arguments["ContinuationToken"] = query["token"]

        self.run_s3([operation, "--cli-input-json", json.dumps(arguments)], region)

    def do_POST(self):
        host = f"127.0.0.1:{self.server.server_port}"
        if (self.headers.get("Host") != host
                or self.headers.get("Origin") != f"http://{host}"
                or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin")):
            self.json_response(403, {"error": "Submit this form from the local console."})
            return
        url = urlsplit(self.path)
        if url.path in ("/api/upload", "/api/delete-object", "/api/delete-bucket"):
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            region = query.get("region", "")
            bucket = query.get("bucket", "")
            if not REGION.fullmatch(region) or not BUCKET.fullmatch(bucket):
                self.json_response(400, {"error": "Invalid bucket or region."})
                return
            if url.path == "/api/delete-bucket":
                self.run_s3(["delete-bucket", f"--bucket={bucket}"], region)
            else:
                self.transfer_object(query, region, action=url.path.removeprefix("/api/"))
            return
        if self.path != "/api/buckets":
            self.json_response(404, {"error": "Page not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get_content_type() != "application/json" or not 0 < length <= 1024:
                raise ValueError
            self.connection.settimeout(5)
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError
        except (OSError, ValueError):
            self.json_response(400, {"error": "Invalid bucket request."})
            return
        bucket, region = payload.get("bucket"), payload.get("region")
        if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            self.json_response(400, {"error": "Enter a bucket name with 3–63 lowercase letters, numbers, dots, or hyphens."})
            return
        if not isinstance(region, str) or not REGION.fullmatch(region):
            self.json_response(400, {"error": "Enter a valid AWS region."})
            return
        operation = ["create-bucket", f"--bucket={bucket}"]
        if region != "us-east-1":
            operation.append(f"--create-bucket-configuration=LocationConstraint={region}")
        self.run_s3(operation, region, success=201)

    def transfer_object(self, query, region, action="download"):
        key = query.get("key", "")
        if not key or "\x00" in key or len(key.encode()) > 1024:
            self.json_response(400, {"error": "Enter an object key of 1–1024 UTF-8 bytes."})
            return
        # JSON preserves literal keys, including keys beginning with file://.
        arguments = ["--cli-input-json", json.dumps({"Bucket": query["bucket"], "Key": key})]
        if action == "delete-object":
            self.run_s3(["delete-object", *arguments], region)
            return
        with tempfile.TemporaryDirectory(prefix="console-s3-") as temp:
            path = Path(temp) / "object"
            if action == "upload":
                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                    if not 0 <= length <= MAX_UPLOAD:
                        self.json_response(400, {"error": "Choose a file up to 64 MiB."})
                        return
                    self.connection.settimeout(10)
                    with path.open("wb") as file:
                        while length:
                            chunk = self.rfile.read(min(length, 65536))
                            if not chunk:
                                raise ValueError
                            file.write(chunk)
                            length -= len(chunk)
                except (OSError, ValueError):
                    self.json_response(400, {"error": "Could not receive the upload."})
                    return
                self.run_s3(["put-object", *arguments, "--body", str(path)], region)
            else:
                # The CLI get-object customization requires explicit bucket and key flags.
                # A parameter file keeps keys beginning with file:// or fileb:// literal.
                key_file = Path(temp) / "key"
                key_file.write_text(key, encoding="utf-8", newline="")
                self.run_s3(["get-object", f"--bucket={query['bucket']}",
                             f"--key=file://{key_file}", str(path)], region,
                            download=(path, key.rsplit("/", 1)[-1] or "object"))

    def run_s3(self, operation, region, success=200, download=None):
        config = self.server.config
        # Use only the emulator credentials file and the explicit loopback endpoint.
        environment = {
            "PATH": os.defpath,
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": str(config.credentials),
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_RETRY_MODE": "standard",
            "AWS_MAX_ATTEMPTS": "1",
        }
        try:
            result = subprocess.run(
                [
                    config.aws, "s3api", *operation, "--endpoint-url", config.endpoint,
                    "--ca-bundle", str(config.ca_bundle), "--region", region,
                    "--no-paginate", "--no-cli-pager", "--no-cli-auto-prompt",
                    "--output", "json", "--cli-connect-timeout", "3", "--cli-read-timeout", "25",
                ],
                env=environment, capture_output=True, timeout=30,
            )
            if result.returncode:
                match = re.search(rb"An error occurred \(([A-Za-z0-9_.-]+)\)", result.stderr)
                code = match[1].decode() if match else None
                status, message = S3_ERRORS.get(code, (502, "The emulator could not complete the S3 request."))
                self.json_response(status, {
                    "error": message,
                    "code": code,
                    "operation": "".join(part.capitalize() for part in operation[0].split("-")),
                })
                return
            if download is None:
                self.json_response(success, json.loads(result.stdout) if result.stdout.strip() else {})
                return
            path, filename = download
            size = path.stat().st_size
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.json_response(502, {"error": "Could not complete the emulator request."})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename, safe='')}")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            with path.open("rb") as file:
                shutil.copyfileobj(file, self.wfile)
        except OSError:
            self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--emulator-port", type=int, default=9297)
    parser.add_argument("--ca-bundle", type=Path)
    parser.add_argument("--credentials", type=Path)
    config = parser.parse_args()
    config.aws = shutil.which("aws")
    if not config.aws:
        parser.error("AWS CLI v2 must be available on PATH.")
    directory = Path.home() / ".aws" / "emulator" / str(config.emulator_port)
    config.ca_bundle = (config.ca_bundle or directory / "ca.pem").expanduser().resolve()
    config.credentials = (config.credentials or directory / "emulator_credentials").expanduser().resolve()
    config.endpoint = f"https://127.0.0.1:{config.emulator_port}"

    with ThreadingHTTPServer(("127.0.0.1", config.port), ConsoleHandler) as server:
        server.config = config
        print(f"Console running at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
