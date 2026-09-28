"""Human-facing delivery and CI status output."""

from __future__ import annotations

import re
import shlex

from cohorte.application.delivery import DeliveryResult, DeliveryStatus


def _safe(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)


def print_delivery_result(delivery: DeliveryResult) -> None:
    print(f"Livraison · {_safe(delivery.url)}")
    print(f"Branche : {_safe(delivery.branch)} → {_safe(delivery.base)}")
    status = delivery.status
    if status == DeliveryStatus.CI_UNKNOWN:
        print("CI : aucun check visible pour l'instant ; résultat encore inconnu")
    elif status == DeliveryStatus.CI_PENDING:
        print("CI : checks en cours")
    elif status == DeliveryStatus.CI_PASSED:
        print("CI : checks visibles réussis")
    elif status == DeliveryStatus.CI_FAILED:
        print("CI : checks en échec ou annulés")
    else:
        print(f"CI : {_safe(status.value)}")
    if delivery.required_checks:
        print("Checks visibles : " + ", ".join(_safe(name) for name in delivery.required_checks))
    if status in {DeliveryStatus.CI_UNKNOWN, DeliveryStatus.CI_PENDING}:
        print(f"Suivre : cohorte delivery-status {shlex.quote(delivery.run_id)} --live --watch")
