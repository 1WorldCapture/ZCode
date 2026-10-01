import assert from "node:assert/strict";
import test from "node:test";

import { isResolvedPathWithin, relativePathEscapesRoot } from "../src/node/pathContainment.js";

test("relativePathEscapesRoot：精确判据（memoryService 行为不变，审核 #8）", () => {
  // 越出：父引用与跨盘绝对形态。
  assert.ok(relativePathEscapesRoot(".."));
  assert.ok(relativePathEscapesRoot("../x"));
  assert.ok(relativePathEscapesRoot("../../x/y"));
  assert.ok(relativePathEscapesRoot("/outside")); // Windows 跨盘时 relative() 会给出绝对路径形态
  // 根内：同级名 "..foo" 首两字符是点但不是父引用——精确形态必须放行。
  assert.ok(!relativePathEscapesRoot("..foo"));
  assert.ok(!relativePathEscapesRoot("a..b"));
  assert.ok(!relativePathEscapesRoot("notes/x.md"));
  assert.ok(!relativePathEscapesRoot(""));
});

test("isResolvedPathWithin：前缀判据带分隔符，防 /root-evil 伪包含", () => {
  const root = "/data/agents";
  assert.ok(isResolvedPathWithin(root, root), "root-equal 放行（调用方按语义排除）");
  assert.ok(isResolvedPathWithin(`${root}/ws`, root));
  assert.ok(isResolvedPathWithin(`${root}/ws/notes/a.md`, root));
  assert.ok(!isResolvedPathWithin("/data/agents-evil", root), "前缀串名不算包含");
  assert.ok(!isResolvedPathWithin("/data", root), "上级不算包含");
  assert.ok(!isResolvedPathWithin("/etc/passwd", root));
  // 根带尾分隔符时归一处理。
  assert.ok(isResolvedPathWithin("/data/agents/ws", `${root}/`));
});
