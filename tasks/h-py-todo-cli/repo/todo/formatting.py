def format_task(task):
    mark = "x" if task.done else " "
    return f"{task.id}. [{mark}] {task.text}"


def format_tasks(tasks):
    return "\n".join(format_task(task) for task in tasks)
