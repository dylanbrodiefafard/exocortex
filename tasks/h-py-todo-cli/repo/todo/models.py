from dataclasses import asdict, dataclass


@dataclass
class Task:
    id: int
    text: str
    done: bool = False

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, raw):
        return cls(**raw)
