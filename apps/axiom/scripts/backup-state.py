"""Stream the Docker volume into an encrypted restic repository."""

import subprocess

COMPOSE = ["docker", "compose", "--profile", "dashboard"]
TAR_COMMAND = ["tar", "-C", "/data/state", "-cf", "-", "."]


def backup() -> None:
    started = subprocess.check_output(
        [*COMPOSE, "ps", "--services", "--status", "running"], text=True,
    ).splitlines()
    writers = [service for service in ("api", "worker") if service in started]
    try:
        if writers:
            subprocess.run([*COMPOSE, "stop", *writers], check=True)
        with subprocess.Popen(
            [*COMPOSE, "run", "--rm", "--no-deps", "-T", "--entrypoint", TAR_COMMAND[0],
             "api", *TAR_COMMAND[1:]],
            stdout=subprocess.PIPE,
        ) as archive:
            try:
                subprocess.run(
                    ["restic", "backup", "--stdin", "--stdin-filename", "axiom-state.tar"],
                    stdin=archive.stdout, check=True,
                )
            finally:
                if archive.stdout:
                    archive.stdout.close()
            if archive.wait():
                raise RuntimeError("The Docker state export failed. Discard this backup attempt.")
    finally:
        if writers:
            subprocess.run([*COMPOSE, "start", *writers], check=True)


if __name__ == "__main__":
    backup()
