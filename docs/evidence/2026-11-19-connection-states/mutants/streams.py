MUTANTS = [
    # One stream up is enough.
    ("  return names.every(streamUp);", "  return names.some(streamUp);"),
    # Up whatever the streams say.
    ("  return names.every(streamUp);", "  return true;"),
]
