# Work goal presenter repair

Opening Replace goal could dismiss both its editor and assistant settings. Goal editors, new-attempt sheets and Clear confirmations now use the stable Work form as their presenter. Task and trigger destinations keep their existing routes.

The editor retains the goal opened by the person. If another session clears that goal while the editor is open, replacement still requires confirmation. Request payloads and resume guards stay unchanged.

The regression failed on the old code while opening the editor. After the repair, three fresh-session cycles passed, along with the existing task-creation smoke test. Subsequent fixture-backed captures passed Set, Replace, Clear and reviewed new-attempt flows on iPhone and iPad. Opus 5.5 High reviewed the repair in `work-presenter-review.md`.

Native Work design baselines are labeled "Before visual design, after essential presenter-lifetime repair." The original failure recording remains diagnostic evidence. Moving Clear to the form also changes its popover anchor, which is shown in the iPad baseline. This functional repair does not close the Work design gate.

Evidence records in the design artifact directory are `work-presenter-functional-evidence.json`, `work-native-before-evidence.json` and `work-goal-presentation-applied.json`. These are simulator and fixture checks. Physical devices and assistive technology were not tested.
