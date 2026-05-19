## Worker Reliability

Workers (delegate_task agents) can stall — they stop making API requests without reporting an error. 

Can be recovered with the following manual workaround:

1. **Interrupt** the task: `task_interrupt(task_id)`
2. **Restart** with a fresh `delegate_task` call using the same description

TODO: implement some sort of check to find stalled workers automatically and restart them
