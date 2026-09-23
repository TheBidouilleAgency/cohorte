"""Read bounded design snapshots from Figma's file API."""

from __future__ import annotations

import http.client
import json
import os
import re
from urllib.parse import parse_qs, quote, urlparse

from cohorte.application.context import DesignDocument

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_FILE_KEY = re.compile(r"^[A-Za-z0-9]{8,128}$")
_NODE_ID = re.compile(r"^\d+[:\-]\d+$")


def _parse_source(source: str) -> tuple[str, str | None]:
    if _FILE_KEY.fullmatch(source):
        return source, None
    parsed = urlparse(source)
    if parsed.scheme != "https" or parsed.hostname not in {"figma.com", "www.figma.com"}:
        raise ValueError("design source must be a Figma HTTPS file URL or file key")
    if parsed.username or parsed.password or parsed.port:
        raise ValueError("design source URL contains unsupported authority")
    parts = parsed.path.strip("/").split("/")
    if len(parts) < 2 or parts[0] not in {"file", "design"} or not _FILE_KEY.fullmatch(parts[1]):
        raise ValueError("design source URL does not contain a valid Figma file key")
    query = parse_qs(parsed.query)
    node_ids = query.get("node-id", [])
    node_id = node_ids[0] if node_ids else None
    if node_id is not None:
        if len(node_ids) != 1 or not _NODE_ID.fullmatch(node_id):
            raise ValueError("design source has an invalid Figma node ID")
        node_id = node_id.replace("-", ":")
    return parts[1], node_id


class FigmaDesignPort:
    def __init__(self, token: str | None = None) -> None:
        self.token = token if token is not None else os.getenv("FIGMA_ACCESS_TOKEN")

    def fetch(self, source: str) -> DesignDocument:
        file_key, node_id = _parse_source(source)
        if not self.token:
            raise RuntimeError("Figma file connection requires FIGMA_ACCESS_TOKEN")
        path = f"/v1/files/{file_key}"
        if node_id is not None:
            path += f"?ids={quote(node_id, safe='')}"
        connection = http.client.HTTPSConnection("api.figma.com", timeout=20)
        try:
            connection.request("GET", path, headers={"X-Figma-Token": self.token})
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError(f"Figma file request failed with HTTP {response.status}")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        except http.client.HTTPException as error:
            raise RuntimeError("Figma file connection failed") from error
        finally:
            connection.close()
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Figma file snapshot exceeds 8 MiB")
        body = json.loads(raw)
        if not isinstance(body, dict) or not isinstance(body.get("document"), dict):
            raise ValueError("Figma file response has no document")
        version = body.get("version")
        if not isinstance(version, str) or not version:
            raise ValueError("Figma file response has no version")
        canonical_source = file_key if node_id is None else f"{file_key}?node-id={node_id}"
        return DesignDocument(
            provider="figma",
            source=canonical_source,
            version=version,
            content=body,
        )
