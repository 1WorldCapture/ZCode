import { ZCODE_DATA_ROOT_NAME, type ZCodeProvider } from "@zcode/shared";

type SkillSourceType = "glm" | "unknown";

/**
 * Classify a skill entry as ours ("glm") or not ("unknown").
 *
 * `scope` is assigned by the service layer (SkillScope: workspace/user/plugin):
 * - workspace-scoped skills live in project dirs whose `.zcode/` name stays
 *   fixed across flavors, and plugin skills live in the CLI plugin cache;
 *   both are trusted without path inspection.
 * - user-scoped skills (and legacy payloads without a scope) must live under
 *   THIS flavor's data root, so another flavor's user directory (e.g.
 *   `~/.zcode/skills` under a TinyCode build) is never adopted.
 */
export function resolveSkillSourceType(
  skill: { path: string; scope?: string },
  dataRootName: string = ZCODE_DATA_ROOT_NAME,
): SkillSourceType {
  if (skill.scope === "workspace" || skill.scope === "plugin") {
    return "glm";
  }
  const normalized = skill.path.replaceAll("\\", "/").toLowerCase();
  const dataRoot = `/${dataRootName.toLowerCase()}/`;
  if (normalized.includes(`${dataRoot}skills/`)) {
    return "glm";
  }
  if (normalized.includes(`${dataRoot}cli/plugins/cache/`)) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isZcodeSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // id-prefix escape hatch keeps legacy payloads without scope working.
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: ZCodeProvider,
): T[] {
  return skills.filter(isZcodeSkill);
}
