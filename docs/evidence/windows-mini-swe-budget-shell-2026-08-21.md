# Windows mini-SWE budget and shell evidence — 2026-08-21

## Failure classification

Run `builder-1787264098546-4cbde99f` created a complete Skill bundle and passed local structure checks, then exited `LimitsExceeded` after 30 assistant calls and 32 bash actions without the explicit completion command. Loom correctly treated it as unsubmitted and did not enter Verifier or Gate.

This was not the earlier blank/non-JSON transport failure. Two runtime causes were visible:

1. no model call was reserved for the completion command after useful work existed;
2. upstream mini-SWE advertised bash but executed actions through `cmd.exe` on Windows, causing repeated quoting and file-writing probes.

## Deterministic and portable fixes

- The default ceiling is now 40 model calls. At 75% consumption the runner asks the model to identify the remaining risk and converge; at two and one calls remaining it progressively reserves a chance to submit a checked candidate. Custom limits remain supported, and terminal reminders take precedence when thresholds overlap.
- No candidate is auto-submitted. Only an upstream terminal event with `exit_status=Submitted` is accepted.
- Local actions now use an explicit Bash process on every platform rather than upstream `shell=True`. Windows auto-discovers Git Bash; POSIX resolves Bash from `PATH`. `LOOM_BASH` and compatible `LOOM_GIT_BASH` can select a deployment-specific shell.
- The action-local `python3` name is mapped to a resolved interpreter. Windows defaults to the pinned mini-SWE virtual-environment Python; POSIX prefers `python3` and falls back to the runner interpreter. `LOOM_PYTHON` is an explicit override. Invalid explicit runtimes fail closed instead of silently selecting another executable.
- The model receives a compact dynamic runtime profile (`platform`, Bash availability, workspace-root cwd, relative POSIX path style, selected Python, Node and Git). It may probe after a concrete tool failure or unavailable capability, but is told not to rediscover capabilities already reported available.
- Non-submitted terminal trajectories now report their exit status and consumed model/tool budget.

## Windows product-entry result

- Plan: `evolution-1787264820585-1hsxubuf`
- Run: `builder-1787264820616-d190282d`
- Target: `skill/builder-json-decision-output`
- Runtime terminal event: `Submitted` on model call 30
- Verifier: `approved`, alignment 196/196, module-load pass, skill-isolation pass
- Gate: `skill-insert`, `cold-skill-load: pass`
- Product result: `completed`, `applied=true`, `effective=true`, `restartRequired=false`

The Actor initially interpreted “Loom” as a target identifier; deterministic kebab-case validation rejected that call. A user clarification identified Loom as the system and the existing Skill id as the target. The accepted redo preserved the original task in a fresh immutable plan.

## Shell probe

The Windows runner executed a Git Bash heredoc containing a pipe character, wrote a relative file, counted one line, and read back `alpha | beta` with exit code 0. This directly tests the action-shell contract without relying on model interpretation.

The same runtime profile was probed in four modes:

- Windows automatic selection: heredoc, pipe, relative path, UTF-8 and pinned `python3` passed.
- Windows explicit `LOOM_BASH`/`LOOM_PYTHON`: the same probes passed.
- Invalid explicit overrides: the action returned `-1` with a missing-runtime explanation and did not silently fall back.
- Linux isolated mini-SWE 2.4.6 environment: Bash, heredoc, pipe, relative path and `python3` all passed.

The final local candidate package was installed into both Windows `web` and `loom` profiles. After explicitly terminating the old listener, a new Web process cold-started and returned HTTP 200. A fresh Actor called `meta_status` and `meta_evolution_status`; both reported active evolution ready, the latest job finished, the task completed/approved/effective, and `restartRequired=false`.

## Six-run stability audit

Six independent immutable Windows product-entry Skill tasks all reached a real `Submitted` terminal event, independent approval, Gate `skill-insert`, cold-load pass and `effective=true`. Model turns were `9, 8, 5, 5, 6, 5` (median `5.5`); tool executions were `8, 7, 4, 4, 5, 4` (median `4.5`). Only attempt 1 had a non-zero tool result, which exposed the old `python3` mapping gap.

Attempts 5 and 6 used the 40-call ceiling plus the dynamic runtime profile. They submitted after 6 and 5 turns, used no environment-discovery action, had no non-zero tool result and never reached the 75% checkpoint. This is evidence that raising the ceiling did not force short tasks to consume extra calls. Attempt 6's raw JSON also preserves the Chinese Actor request exactly; the earlier garbling was PowerShell/SSH display encoding only.

The machine-readable aggregate is `/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-stability-6/report.json`; its sibling files retain all six trajectories, plans, Verifier reports and filtered Gate history.

## Boundaries

This proves recovery of one near-complete Skill run, six subsequent bounded Skill closures, portable runtime selection on Windows/Linux, and elimination of the observed shell/path/Python environment waste after runtime-profile injection. It does not prove that every task will converge by 40 calls, that every installed model will follow a Skill, or that Loop-level complex source refactors are stable.

Raw artifacts: `/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-budget-shell/` and `/chenzute/dsh-src/eval/run-records/2026-08-21-windows-mini-swe-stability-6/`.
