import type { HostFileChange } from "@codexhost/harness-adapter";

interface SplitDiff {
  oldHeader: string;
  newHeader: string;
  body: string[];
}

/**
 * A Unified Diff produced by an Adapter always leads with the `--- ` / `+++ `
 * file header pair. Anything else is left untouched so unknown shapes never
 * lose content.
 */
function splitDiff(unifiedDiff: string): SplitDiff | null {
  const lines = unifiedDiff.split("\n");
  const [oldHeader, newHeader, ...body] = lines;
  if (oldHeader === undefined || newHeader === undefined) return null;
  if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ ")) return null;
  while (body.at(-1) === "") body.pop();
  return { oldHeader, newHeader, body };
}

function mergedKind(group: readonly HostFileChange[]): HostFileChange["kind"] {
  const first = group[0];
  const last = group.at(-1);
  if (first?.kind === "add") return "add";
  if (last?.kind === "delete") return "delete";
  return "update";
}

function mergeGroup(group: readonly HostFileChange[]): HostFileChange[] {
  const first = group[0];
  if (!first) return [];
  if (group.length === 1) return [first];
  const parts = group.map(({ unifiedDiff }) => splitDiff(unifiedDiff));
  const firstPart = parts[0];
  const lastPart = parts.at(-1);
  if (!firstPart || !lastPart || parts.some((part) => part === null)) return [...group];
  const body = parts.flatMap((part) => part?.body ?? []);
  return [
    {
      path: first.path,
      kind: mergedKind(group),
      unifiedDiff: [firstPart.oldHeader, lastPart.newHeader, ...body, ""].join("\n"),
    },
  ];
}

/**
 * Collapse the File Changes of one Turn so each file appears once.
 *
 * A Harness that edits the same file several times reports one File Change per
 * edit, and Codex Desktop derives its file count and added/deleted line summary
 * by reading the aggregate Turn Diff. Without this the same path is summarised
 * once per edit.
 *
 * The merged Diff concatenates hunks in edit order under a single header pair.
 * Later hunk coordinates address intermediate file revisions, so the result is a
 * faithful summary rather than a patch that can be applied as a whole.
 */
export function mergeFileChangesByPath(changes: readonly HostFileChange[]): HostFileChange[] {
  const groups = new Map<string, HostFileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) group.push(change);
    else groups.set(change.path, [change]);
  }
  return [...groups.values()].flatMap((group) => mergeGroup(group));
}
