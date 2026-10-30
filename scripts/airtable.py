"""Small Airtable REST client for the test scripts (snapshots and reset). The workflow itself
writes through n8n; these scripts only read, and clear the demo base before a fresh run."""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from .envfile import load_env, mask, require
except ImportError:
    from envfile import load_env, mask, require

TABLES = ("Listings", "Sync Runs", "Row Errors")


class Airtable:
    def __init__(self, values=None):
        self.values = values or load_env()
        self.token = require(self.values, "AIRTABLE_TOKEN")
        self.base = require(self.values, "AIRTABLE_BASE_ID")

    def _request(self, method, table, query=None, body=None):
        url = f"https://api.airtable.com/v0/{self.base}/{urllib.parse.quote(table)}"
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    time.sleep(0.22)  # stay under 5 requests per second
                    return json.loads(response.read())
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 3:
                    time.sleep(30)
                    continue
                raise SystemExit(f"Airtable {method} {table} failed: HTTP {error.code} {mask(error.read().decode()[:300], self.values)}")
        raise SystemExit("Airtable kept answering 429")

    def records(self, table, formula=None):
        out, offset = [], None
        while True:
            query = {"pageSize": 100}
            if formula:
                query["filterByFormula"] = formula
            if offset:
                query["offset"] = offset
            page = self._request("GET", table, query)
            out.extend(page["records"])
            offset = page.get("offset")
            if not offset:
                return out

    def clear(self, table):
        ids = [record["id"] for record in self.records(table)]
        for start in range(0, len(ids), 10):
            self._request("DELETE", table, {"records[]": ids[start:start + 10]})
        return len(ids)
