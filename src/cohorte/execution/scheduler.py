from __future__ import annotations

from dataclasses import dataclass

from cohorte.domain.models import Task


@dataclass(frozen=True, slots=True)
class ActiveTask:
    task_id: str
    account_ref: str
    write_paths: tuple[str, ...]


def paths_overlap(left: str, right: str) -> bool:
    left = left.rstrip("/")
    right = right.rstrip("/")
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def schedule_ready(
    tasks: list[Task],
    completed: set[str],
    active: list[ActiveTask],
    max_parallel_per_account: int = 2,
    max_parallel_global: int = 4,
) -> list[Task]:
    """Select a deterministic maximal batch without changing task/account ownership."""
    if len(active) >= max_parallel_global:
        return []
    known = {task.id for task in tasks}
    if not completed <= known:
        raise ValueError("completed contains an unknown task")
    active_ids = {item.task_id for item in active}
    account_counts: dict[str, int] = {}
    claimed = [path for item in active for path in item.write_paths]
    for item in active:
        account_counts[item.account_ref] = account_counts.get(item.account_ref, 0) + 1
    selected: list[Task] = []
    for task in sorted(tasks, key=lambda candidate: candidate.id):
        if task.id in completed or task.id in active_ids or not set(task.depends_on) <= completed:
            continue
        if len(active) + len(selected) >= max_parallel_global:
            break
        count = account_counts.get(task.account_ref, 0)
        if count >= max_parallel_per_account:
            continue
        if any(paths_overlap(path, existing) for path in task.write_paths for existing in claimed):
            continue
        selected.append(task)
        account_counts[task.account_ref] = count + 1
        claimed.extend(task.write_paths)
    return selected
