MUTANTS = [
    # A closed stream is not counted.
    ("    closings.set(name, (closings.get(name) ?? 0) + 1);\n", ""),
    # The scope is only the names.
    (
        '  const scope = names.map((name) => `${name}#${closings.get(name) ?? 0}`).join(" ");',
        '  const scope = names.join(" ");',
    ),
]
