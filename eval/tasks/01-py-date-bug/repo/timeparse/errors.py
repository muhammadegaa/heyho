class ParseError(ValueError):
    """Raised when a string cannot be parsed as a date, time or UTC offset."""

    def __init__(self, text, reason):
        super().__init__(f"cannot parse {text!r}: {reason}")
        self.text = text
        self.reason = reason
