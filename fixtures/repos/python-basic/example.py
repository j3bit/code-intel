class Greeter:
    def format_greeting(self, name: str) -> str:
        return f"hello {name}"


def greet(name: str) -> str:
    return Greeter().format_greeting(name)
