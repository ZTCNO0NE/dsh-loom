#!/usr/bin/env python3
"""Non-interactive mini-SWE launcher used by Loom worker processes.

mini-SWE 2.4.6's ``mini`` CLI imports prompt_toolkit at module load time. On
Windows child processes without a console buffer that crashes before its yolo
mode can start. This runner deliberately imports only the default agent path.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from minisweagent.agents import get_agent
from minisweagent.agents.default import DefaultAgent
from minisweagent.config import get_config_from_spec
from minisweagent.environments import get_environment
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models import get_model
from minisweagent.utils.serialize import UNSET, recursive_merge


class LoomDefaultAgent(DefaultAgent):
    """Default agent with a soft landing before mini-SWE's hard step limit.

    The upstream agent raises ``LimitsExceeded`` before issuing another model
    call once ``step_limit`` is reached.  A model that has already produced a
    usable candidate can otherwise spend its final calls on redundant checks
    and never get a chance to emit the explicit completion command.  These
    reminders reserve that chance without auto-submitting files or weakening
    Loom's independent compiler, Verifier, or Gate.
    """

    def __init__(self, model, env, **kwargs):
        super().__init__(model, env, **kwargs)
        self._loom_budget_notice = 0

    def query(self) -> dict:
        step_limit = self.config.step_limit
        remaining = step_limit - self.n_calls if step_limit > 0 else 0
        notice = ""
        notice_level = 0
        convergence_call = max(1, int(step_limit * 0.75)) if step_limit > 0 else 0
        # Terminal notices take precedence for small custom budgets where the
        # 75% checkpoint can coincide with the last one or two calls.
        if step_limit > 0 and remaining == 1:
            notice_level = 3
            notice = (
                "LOOM RUNTIME FINAL CALL: do not inspect or edit further. If a "
                "usable candidate exists, execute exactly "
                "`echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` now. If it does not, "
                "allow the run to fail closed; never claim success without it."
            )
        elif step_limit > 0 and remaining == 2:
            notice_level = 2
            notice = (
                "LOOM RUNTIME BUDGET: only 2 model calls remain. Stop broad or "
                "repeated inspection. If the requested artifact exists and one "
                "relevant check has passed, use the exact completion command now. "
                "Otherwise make at most one necessary correction, then submit."
            )
        elif step_limit > 0 and self.n_calls == convergence_call:
            notice_level = 1
            notice = (
                f"LOOM RUNTIME CONVERGENCE CHECKPOINT: {remaining} model calls remain. "
                "If a candidate exists, state the one unresolved risk, run only the "
                "smallest relevant check, and submit when it passes. Use the remaining "
                "budget for environment diagnosis only when a concrete tool error still blocks progress."
            )
        if notice and notice_level > self._loom_budget_notice:
            self.add_messages(self.model.format_message(role="user", content=notice))
            self._loom_budget_notice = notice_level
        return super().query()


class LoomLocalEnvironment(LocalEnvironment):
    """Keep mini-SWE's bash action contract true on every supported host.

    Upstream ``LocalEnvironment`` uses ``shell=True``: that means ``cmd.exe``
    on Windows and may mean a non-bash ``/bin/sh`` on POSIX. Loom resolves one
    explicit Bash runtime and one Python interpreter before actions. Advanced
    deployments can override them with ``LOOM_BASH`` and ``LOOM_PYTHON``.
    """

    @staticmethod
    def _resolve_executable(value: str | None) -> str | None:
        if not value:
            return None
        discovered = shutil.which(value)
        if discovered:
            return discovered
        path = Path(value)
        return str(path) if path.is_file() else None

    @classmethod
    def _bash(cls) -> str | None:
        explicit = os.environ.get("LOOM_BASH") or os.environ.get("LOOM_GIT_BASH")
        if explicit:
            return cls._resolve_executable(explicit)
        if os.name != "nt":
            return shutil.which("bash")
        git = shutil.which("git")
        candidates = [
            Path(git).parent.parent / "bin" / "bash.exe" if git else None,
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git" / "bin" / "bash.exe",
            Path(os.environ.get("LocalAppData", "")) / "Programs" / "Git" / "bin" / "bash.exe",
        ]
        return next((str(path) for path in candidates if path and path.is_file()), None)

    @classmethod
    def _python(cls) -> str | None:
        explicit = os.environ.get("LOOM_PYTHON")
        if explicit:
            return cls._resolve_executable(explicit)
        if os.name == "nt":
            return sys.executable
        return shutil.which("python3") or sys.executable

    def runtime_summary(self) -> str:
        platform_name = "windows" if os.name == "nt" else sys.platform
        shell = "bash" if self._bash() else "unavailable"
        python = "pinned" if self._python() else "unavailable"
        node = "available" if shutil.which("node") else "unavailable"
        git = "available" if shutil.which("git") else "unavailable"
        return (
            f"platform={platform_name}; shell={shell}; cwd=workspace-root; path-style=relative-posix; "
            f"python3={python}; node={node}; git={git}; "
            "overrides=LOOM_BASH,LOOM_PYTHON"
        )

    def get_template_vars(self, **kwargs) -> dict:
        return recursive_merge(super().get_template_vars(**kwargs), {"loom_runtime_summary": self.runtime_summary()})

    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict:
        command = action.get("command", "")
        workdir = cwd or self.config.cwd or os.getcwd()
        bash = self._bash()
        python = self._python()
        if not bash or not python:
            missing = "Bash" if not bash else "Python"
            output = {
                "output": f"{missing} is unavailable for Loom's mini-SWE runtime. Configure LOOM_BASH/LOOM_PYTHON or install the required runtime.\n",
                "returncode": -1,
                "exception_info": f"Loom action runtime missing {missing}",
            }
            self._check_finished(output)
            return output
        try:
            # WindowsApps may expose a non-functional ``python3`` stub; other
            # hosts may have several project interpreters. Bind the common name
            # to the resolved runtime profile for this action only.
            command = (
                "python3() { \"$LOOM_PYTHON\" \"$@\"; }\n"
                + command
            )
            action_env = os.environ | self.config.env | {"LOOM_PYTHON": python}
            result = subprocess.run(
                [bash, "--noprofile", "--norc", "-lc", command],
                cwd=workdir,
                env=action_env,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout or self.config.timeout,
                check=False,
            )
            output = {"output": result.stdout, "returncode": result.returncode, "exception_info": ""}
        except Exception as error:
            raw_output = getattr(error, "stdout", None) or getattr(error, "output", None) or ""
            if isinstance(raw_output, bytes):
                raw_output = raw_output.decode("utf-8", errors="replace")
            output = {
                "output": raw_output,
                "returncode": -1,
                "exception_info": f"An error occurred while executing Bash: {error}",
                "extra": {"exception_type": type(error).__name__, "exception": str(error)},
            }
        self._check_finished(output)
        return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config", action="append", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--timeout-seconds", type=int, required=True)
    parser.add_argument("--step-limit", type=int, required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    configs = [get_config_from_spec(spec) for spec in args.config]
    configs.append({
        "run": {"task": args.task},
        "agent": {
            "agent_class": "default", "mode": "yolo", "confirm_exit": False,
            "output_path": Path(args.output), "step_limit": args.step_limit,
            "wall_time_limit_seconds": args.timeout_seconds,
        },
        # mini-SWE delegates to LiteLLM.  Loom's public Builder model names
        # are provider-neutral, while LiteLLM requires an explicit provider
        # for the OpenAI-compatible endpoints used by DeepSeek and Terra.
        "model": {
            "model_name": args.model if "/" in args.model else f"openai/{args.model}",
            # mini-SWE forwards model_kwargs directly to LiteLLM.  Explicitly
            # supply api_base so OpenAI-compatible providers never fall back
            # to api.openai.com in a non-interactive child process.
            "model_kwargs": {"api_base": os.environ["OPENAI_API_BASE"]} if os.environ.get("OPENAI_API_BASE") else {},
        },
        "environment": {"cwd": args.workspace},
    })
    config = recursive_merge(*configs)
    model = get_model(config=config.get("model", {}))
    environment_config = dict(config.get("environment", {}))
    environment_class = environment_config.pop("environment_class", "local")
    if environment_class == "local":
        environment = LoomLocalEnvironment(**environment_config)
    else:
        environment = get_environment({"environment_class": environment_class, **environment_config}, default_type="local")
    agent_config = dict(config.get("agent", {}))
    agent_class = agent_config.pop("agent_class", "default")
    if agent_class == "default":
        agent = LoomDefaultAgent(model, environment, **agent_config)
    else:
        agent = get_agent(model, environment, {"agent_class": agent_class, **agent_config}, default_type="default")
    agent.run(config.get("run", {}).get("task", UNSET))


if __name__ == "__main__":
    main()
