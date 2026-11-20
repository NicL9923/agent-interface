MUTANTS = [
    # One stream up is enough.
    (
        '  return names.every(streamUp) ? "up" : "waiting";',
        '  return names.some(streamUp) ? "up" : "waiting";',
    ),
    # Up whatever the streams say.
    ('  return names.every(streamUp) ? "up" : "waiting";', '  return "up";'),
    # A closed stream counts as waiting.
    ('  if (names.some((name) => !streams.has(name))) return "closed";', ""),
]
