# Exit codes

The CLI uses stable class-level exit codes so scripts can distinguish usage, policy and runtime failures.

| Code | Class |
|---:|---|
| 0 | completed |
| 2 | usage |
| 3 | migration or command rejected |
| 4 | accepted asynchronously |
| 10 | configuration |
| 11 | validation |
| 12 | permission |
| 13 | security |
| 14 | provider-transient or provider-terminal |
| 15 | tool-transient or tool-terminal |
| 16 | conflict or cancelled |
| 17 | budget |
| 18 | timeout |
| 19 | corruption |
| 20 | human-required |
