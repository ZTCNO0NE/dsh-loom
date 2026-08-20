#!/usr/bin/env python3
"""Non-interactive mini-SWE launcher used by Loom worker processes.

mini-SWE 2.4.6's ``mini`` CLI imports prompt_toolkit at module load time. On
Windows child processes without a console buffer that crashes before its yolo
mode can start. This runner deliberately imports only the default agent path.
"""
import argparse
from pathlib import Path

from minisweagent.agents import get_agent
from minisweagent.config import get_config_from_spec
from minisweagent.environments import get_environment
from minisweagent.models import get_model
from minisweagent.utils.serialize import UNSET, recursive_merge


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
        "model": {"model_name": args.model},
        "environment": {"cwd": args.workspace},
    })
    config = recursive_merge(*configs)
    model = get_model(config=config.get("model", {}))
    environment = get_environment(config.get("environment", {}), default_type="local")
    agent = get_agent(model, environment, config.get("agent", {}), default_type="default")
    agent.run(config.get("run", {}).get("task", UNSET))


if __name__ == "__main__":
    main()
