from __future__ import annotations

from cohorte.domain.models import Task
from cohorte.execution.scheduler import ActiveTask, paths_overlap, schedule_ready


def task(
    identifier: str, path: str, depends_on: list[str] | None = None, account: str = "a"
) -> Task:
    return Task(
        id=identifier,
        role="implementer",
        surface_ids=["surface"],
        criterion_ids=[f"ac-{identifier}"],
        depends_on=depends_on or [],
        write_paths=[path],
        account_ref=account,
        model="model",
    )


def test_path_overlap_understands_ancestors() -> None:
    assert paths_overlap("src", "src/app/file.py")
    assert not paths_overlap("src/api", "src/web")


def test_scheduler_parallelizes_independent_tasks() -> None:
    selected = schedule_ready([task("one", "src/api"), task("two", "src/web")], set(), [])
    assert [item.id for item in selected] == ["one", "two"]


def test_scheduler_serializes_overlapping_writes() -> None:
    selected = schedule_ready([task("one", "src"), task("two", "src/web")], set(), [])
    assert [item.id for item in selected] == ["one"]


def test_scheduler_honors_dependencies_and_account_limit() -> None:
    tasks = [
        task("one", "one"),
        task("two", "two"),
        task("three", "three", depends_on=["one"]),
    ]
    active = [ActiveTask(task_id="running", account_ref="a", write_paths=("other",))]
    selected = schedule_ready(tasks, set(), active, max_parallel_per_account=2)
    assert [item.id for item in selected] == ["one"]
