## Master plan — explicit request only

Do not create, advance or change a master plan on your own initiative: act only when the user explicitly asks, then follow the `master-plan` skill. The plan is `{{sdd.specsDir}}/_plan/PLAN.md` and slice state is derived from git — read it with `navori master status`, never from a file you keep. Never run `navori master accept` or `reject`: only the user records a verdict. Work outside the plan (fixes, chores, hotfixes) needs no slice.
