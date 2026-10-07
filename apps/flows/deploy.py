"""Registers the flows of a branch as deployments on the work pool `agora`.

Run in the Prefect worker's Pod, which has git and Prefect's API: `python deploy.py [branch]`.
Each run of a deployment clones the branch again, so a push changes the next run without this.
"""

import sys

from prefect import flow
from prefect.runner.storage import GitRepository

REPOSITORY = "https://github.com/arnaultbretagne/agora.git"

branch = sys.argv[1] if len(sys.argv) > 1 else "design/agora-foundations"
source = GitRepository(url=REPOSITORY, branch=branch)
for entrypoint in ("apps/flows/flows.py:rehearsal", "apps/flows/flows.py:archi_dev_review"):
    deployment = flow.from_source(source=source, entrypoint=entrypoint).deploy(
        name=branch.replace("/", "-"), work_pool_name="agora", print_next_steps=False
    )
    print("deployed", entrypoint, "from", branch, deployment)
