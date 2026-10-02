import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSkillsForProvider,
  resolveSkillSourceType,
} from "../src/lib/skillSourceFilter.js";

// Both product flavors drive the same classifier; only the injected data-root
// constant differs (.zcode vs .tinycode).
const FLAVORS = [
  { label: "ZCode (.zcode)", dataRoot: ".zcode" },
  { label: "TinyCode (.tinycode)", dataRoot: ".tinycode" },
] as const;

test("workspace-scoped skills are kept regardless of path, in both flavors", () => {
  for (const { label, dataRoot } of FLAVORS) {
    assert.equal(
      resolveSkillSourceType(
        { path: "/home/user/proj/.zcode/skills/notes/SKILL.md", scope: "workspace" },
        dataRoot,
      ),
      "glm",
      label,
    );
    // Project dir keeps the fixed `.zcode` name even under TinyCode.
    assert.equal(
      resolveSkillSourceType(
        { path: "/home/user/proj/.zcode/skills/notes/SKILL.md", scope: "workspace" },
        dataRoot,
      ),
      "glm",
      label,
    );
  }
});

test("plugin-scoped skills are kept regardless of path, in both flavors", () => {
  for (const { label, dataRoot } of FLAVORS) {
    assert.equal(
      resolveSkillSourceType(
        { path: "/somewhere/else/plugins/cache/p/skills/x/SKILL.md", scope: "plugin" },
        dataRoot,
      ),
      "glm",
      label,
    );
  }
});

test("user-scoped skills only match this flavor's data root", () => {
  assert.equal(
    resolveSkillSourceType({ path: "~/.zcode/skills/x/SKILL.md", scope: "user" }, ".zcode"),
    "glm",
    "ZCode keeps its own user root",
  );
  assert.equal(
    resolveSkillSourceType({ path: "~/.tinycode/skills/x/SKILL.md", scope: "user" }, ".tinycode"),
    "glm",
    "TinyCode keeps its own user root",
  );
  assert.equal(
    resolveSkillSourceType({ path: "~/.zcode/skills/x/SKILL.md", scope: "user" }, ".tinycode"),
    "unknown",
    "TinyCode must not adopt the ZCode user root",
  );
  assert.equal(
    resolveSkillSourceType({ path: "~/.tinycode/skills/x/SKILL.md", scope: "user" }, ".zcode"),
    "unknown",
    "ZCode must not adopt the TinyCode user root",
  );
});

test("legacy payloads without scope fall back to path matching", () => {
  assert.equal(resolveSkillSourceType({ path: "~/.zcode/skills/x/SKILL.md" }, ".zcode"), "glm");
  assert.equal(
    resolveSkillSourceType({ path: "~/.zcode/cli/plugins/cache/p/x/SKILL.md" }, ".zcode"),
    "glm",
  );
  assert.equal(
    resolveSkillSourceType({ path: "~/.tinycode/skills/x/SKILL.md" }, ".tinycode"),
    "glm",
  );
  assert.equal(
    resolveSkillSourceType({ path: "~/.tinycode/cli/plugins/cache/p/x/SKILL.md" }, ".tinycode"),
    "glm",
  );
  // Cross-flavor user dirs stay rejected without a scope, too.
  assert.equal(resolveSkillSourceType({ path: "~/.zcode/skills/x/SKILL.md" }, ".tinycode"), "unknown");
  assert.equal(resolveSkillSourceType({ path: "~/documents/foo" }, ".zcode"), "unknown");
});

test("windows-style separators are normalized before matching", () => {
  assert.equal(
    resolveSkillSourceType({ path: "C:\\Users\\u\\.tinycode\\skills\\x\\SKILL.md" }, ".tinycode"),
    "glm",
  );
});

test("filterSkillsForProvider keeps glm: ids and drops foreign user skills", () => {
  // Test runtime has no define injected, so the shared constant falls back to
  // ".zcode" — the ZCode flavor default.
  const kept = filterSkillsForProvider(
    [
      { path: "/unrelated/path/SKILL.md", id: "glm:bundled" },
      { path: "~/.zcode/skills/local/SKILL.md", scope: "user" },
      { path: "/proj/.zcode/skills/ws/SKILL.md", scope: "workspace" },
      { path: "~/.tinycode/skills/foreign/SKILL.md", scope: "user" },
    ],
    "glm" as never,
  );
  assert.deepEqual(
    kept.map((skill) => skill.id ?? skill.path),
    ["glm:bundled", "~/.zcode/skills/local/SKILL.md", "/proj/.zcode/skills/ws/SKILL.md"],
  );
});
