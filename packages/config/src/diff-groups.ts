import type { Group, GroupId } from "@friday/core";

/**
 * Groups whose project dirs changed after a reload: removed, or present in both with a different
 * `workspaces` list. Instructions and members are not compared. Sorted.
 */
export function diffGroups(prev: Map<GroupId, Group>, next: Map<GroupId, Group>): GroupId[] {
  const changed: GroupId[] = [];
  for (const [id, group] of prev) {
    const now = next.get(id);
    if (!now || JSON.stringify(now.workspaces) !== JSON.stringify(group.workspaces)) {
      changed.push(id);
    }
  }
  return changed.sort();
}
