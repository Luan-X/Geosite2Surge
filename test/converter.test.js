import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildGeosite2Surge, parseListText, regexToWildcard } from "../src/index.js";

test("parses geosite lines with comments and attributes", () => {
  const entries = parseListText(
    "sample",
    [
      "# comment",
      "example.com @cn # root domain",
      "full:api.example.com @ads",
      "include:child @-!cn"
    ].join("\n")
  );

  assert.equal(entries[0].kind, "comment");
  assert.equal(entries[1].kind, "rule");
  assert.deepEqual(entries[1].attrs, ["cn"]);
  assert.equal(entries[1].comment, "root domain");
  assert.equal(entries[3].kind, "include");
  assert.deepEqual(entries[3].attrs, ["-!cn"]);
});

test("converts common regexp forms to Surge wildcard rules", () => {
  assert.equal(regexToWildcard("^hses[1-7]?\\.akamaized\\.net$"), "hses*.akamaized.net");
  assert.equal(regexToWildcard("(^|\\.)bilibili3(0[1-9]|1[0-2])\\.xyz$"), "*bilibili3*.xyz");
  assert.equal(regexToWildcard("(^|\\.)[a-z][1-9][0-9][a-z]\\.com$"), "*????.com");
});

test("builds Surge files, expands includes, and writes aggregate attribute files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geosite2surge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dataDir = path.join(root, "domain-list-community", "data");
  const outDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, "google"),
    [
      "# Google",
      "include:android",
      "keyword:google",
      "regexp:^g[0-9]+\\.googlevideo\\.com$ @ads"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, "android"),
    ["android.com", "full:android.googlesource.com @cn", "play.google.com @!cn"].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(dataDir, "china"), ["include:android @-!cn"].join("\n"), "utf8");

  const result = buildGeosite2Surge({
    cwd: root,
    dataDir,
    outDir,
    repo: "owner/repo",
    branch: "main"
  });

  assert.equal(result.sourceFiles, 3);
  assert.ok(fs.existsSync(path.join(outDir, "google")));
  assert.ok(fs.existsSync(path.join(outDir, "ads")));
  assert.ok(fs.existsSync(path.join(outDir, "!cn")));
  assert.ok(fs.existsSync(path.join(outDir, "cn")));

  assert.match(fs.readFileSync(path.join(outDir, "google"), "utf8"), /#include:android/);
  assert.match(fs.readFileSync(path.join(outDir, "google"), "utf8"), /DOMAIN-SUFFIX,android\.com/);
  assert.match(fs.readFileSync(path.join(outDir, "google"), "utf8"), /DOMAIN-KEYWORD,google/);
  assert.match(fs.readFileSync(path.join(outDir, "ads"), "utf8"), /DOMAIN-WILDCARD,g\*\.googlevideo\.com/);

  const china = fs.readFileSync(path.join(outDir, "china"), "utf8");
  assert.match(china, /DOMAIN-SUFFIX,android\.com/);
  assert.match(china, /DOMAIN,android\.googlesource\.com/);
  assert.doesNotMatch(china, /play\.google\.com/);

  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /owner\/repo\/refs\/heads\/main\/data\/google/);
});
