"""Status codes and their reason phrases."""

REASONS = {
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    304: "Not Modified",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    422: "Unprocessable Content",
    500: "Internal Server Error",
}


def reason_phrase(status: int) -> str:
    return REASONS.get(status, "Unknown")


def is_redirect(status: int) -> bool:
    return status in (301, 302, 303, 307, 308)
