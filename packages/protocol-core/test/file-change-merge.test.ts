import { describe, expect, it } from "vitest";
import type { HostFileChange } from "@codexhost/harness-adapter";

import { mergeFileChangesByPath } from "../src/index.js";

function update(path: string, body: string): HostFileChange {
  return { path, kind: "update", unifiedDiff: `--- a/${path}\n+++ b/${path}\n${body}\n` };
}

describe("mergeFileChangesByPath", () => {
  it("collapses repeated edits of one file into a single Diff section", () => {
    const merged = mergeFileChangesByPath([
      update("PLAN.md", "@@ -1,1 +1,1 @@\n-first\n+second"),
      update("PLAN.md", "@@ -8,1 +8,2 @@\n-third\n+fourth\n+fifth"),
    ]);
    expect(merged).toEqual([
      {
        path: "PLAN.md",
        kind: "update",
        unifiedDiff: [
          "--- a/PLAN.md",
          "+++ b/PLAN.md",
          "@@ -1,1 +1,1 @@",
          "-first",
          "+second",
          "@@ -8,1 +8,2 @@",
          "-third",
          "+fourth",
          "+fifth",
          "",
        ].join("\n"),
      },
    ]);
    const added = merged[0]?.unifiedDiff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    expect(added).toHaveLength(3);
  });

  it("keeps distinct files separate and preserves first-appearance order", () => {
    const merged = mergeFileChangesByPath([
      update("a.txt", "@@ -1 +1 @@\n-a\n+A"),
      update("b.txt", "@@ -1 +1 @@\n-b\n+B"),
      update("a.txt", "@@ -2 +2 @@\n-c\n+C"),
    ]);
    expect(merged.map(({ path }) => path)).toEqual(["a.txt", "b.txt"]);
    expect(merged[0]?.unifiedDiff).toContain("+C");
  });

  it("keeps a created file reported as an addition", () => {
    const merged = mergeFileChangesByPath([
      {
        path: "new.txt",
        kind: "add",
        unifiedDiff: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+one\n",
      },
      update("new.txt", "@@ -1 +1,2 @@\n one\n+two"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("add");
    expect(merged[0]?.unifiedDiff.startsWith("--- /dev/null\n+++ b/new.txt\n")).toBe(true);
  });

  it("reports a file removed after edits as a deletion", () => {
    const merged = mergeFileChangesByPath([
      update("gone.txt", "@@ -1 +1 @@\n-a\n+b"),
      {
        path: "gone.txt",
        kind: "delete",
        unifiedDiff: "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-b\n",
      },
    ]);
    expect(merged[0]).toMatchObject({ kind: "delete" });
    expect(merged[0]?.unifiedDiff.split("\n")[1]).toBe("+++ /dev/null");
  });

  it("passes a single change through untouched", () => {
    const only = update("solo.txt", "@@ -1 +1 @@\n-x\n+y");
    expect(mergeFileChangesByPath([only])).toEqual([only]);
  });

  it("leaves a group unmerged when any Diff lacks the file header pair", () => {
    const headerless: HostFileChange = {
      path: "odd.txt",
      kind: "update",
      unifiedDiff: "@@ -1 +1 @@\n-x\n+y\n",
    };
    const normal = update("odd.txt", "@@ -2 +2 @@\n-p\n+q");
    expect(mergeFileChangesByPath([normal, headerless])).toEqual([normal, headerless]);
  });

  it("returns nothing for no changes", () => {
    expect(mergeFileChangesByPath([])).toEqual([]);
  });
});
