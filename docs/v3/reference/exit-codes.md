# Exit codes

The CLI uses stable class-level exit codes so scripts can distinguish usage, policy and runtime failures.

| Code | Class |
|---:|---|
| 0 | completed |
| 2 | usage |
| 3 | migration or command rejected |
| 4 | accepted asynchronously |
| 10 | configuration |
| 11 | security |
| 12 | conflict |
| 13 | provider |
| 14 | corruption |
| 15 | internal |
