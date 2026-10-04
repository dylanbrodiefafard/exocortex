import argparse
import sys

from todo import storage
from todo.formatting import format_tasks


def build_parser():
    parser = argparse.ArgumentParser(prog="todo", description="Manage a todo list.")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="add a task")
    add.add_argument("text", help="task description")

    sub.add_parser("list", help="list tasks")

    done = sub.add_parser("done", help="mark a task as done")
    done.add_argument("id", type=int)

    remove = sub.add_parser("remove", help="delete a task")
    remove.add_argument("id", type=int)

    return parser


def cmd_add(args, todos):
    text = args.text.strip()
    if not text:
        print("error: task text must not be empty", file=sys.stderr)
        return 2
    task = todos.add(text)
    storage.save(todos)
    print(f"Added task {task.id}")
    return 0


def cmd_list(args, todos):
    if todos.tasks:
        print(format_tasks(todos.tasks))
    return 0


def cmd_done(args, todos):
    task = todos.find(args.id)
    if task is None:
        print(f"error: no task with id {args.id}", file=sys.stderr)
        return 1
    task.done = True
    storage.save(todos)
    return 0


def cmd_remove(args, todos):
    if not todos.remove(args.id):
        print(f"error: no task with id {args.id}", file=sys.stderr)
        return 1
    storage.save(todos)
    return 0


COMMANDS = {
    "add": cmd_add,
    "list": cmd_list,
    "done": cmd_done,
    "remove": cmd_remove,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    todos = storage.load()
    return COMMANDS[args.command](args, todos)
