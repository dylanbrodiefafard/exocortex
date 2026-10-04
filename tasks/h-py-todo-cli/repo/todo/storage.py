import json
import os
from pathlib import Path

from todo.models import Task

DEFAULT_PATH = Path.home() / ".todo.json"


def data_path():
    """Location of the data file: $TODO_FILE, or ~/.todo.json."""
    override = os.environ.get("TODO_FILE")
    return Path(override) if override else DEFAULT_PATH


class TodoList:
    def __init__(self, tasks=None, next_id=1):
        self.tasks = list(tasks or [])
        self.next_id = next_id

    def add(self, text):
        task = Task(id=self.next_id, text=text)
        self.tasks.append(task)
        self.next_id += 1
        return task

    def find(self, task_id):
        for task in self.tasks:
            if task.id == task_id:
                return task
        return None

    def remove(self, task_id):
        task = self.find(task_id)
        if task is None:
            return False
        self.tasks.remove(task)
        return True


def load(path=None):
    path = path or data_path()
    if not path.exists():
        return TodoList()
    with path.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    tasks = [Task.from_dict(item) for item in raw.get("tasks", [])]
    return TodoList(tasks, raw.get("next_id", 1))


def save(todos, path=None):
    path = path or data_path()
    payload = {"next_id": todos.next_id, "tasks": [task.to_dict() for task in todos.tasks]}
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
