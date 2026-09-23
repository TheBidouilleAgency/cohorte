from __future__ import annotations

from cohorte.application.intake import IntakeAnswer, IntakeReport, IntakeTriage


def parse_answers(raw_answers: list[str], questions: list[str]) -> list[IntakeAnswer]:
    answers: list[IntakeAnswer] = []
    for raw in raw_answers:
        number, separator, response = raw.partition("=")
        if not separator or not number.isdecimal() or not response.strip():
            raise ValueError("intake --answer must use N=réponse for an open question")
        index = int(number) - 1
        if index < 0 or index >= len(questions):
            raise ValueError(f"intake question {number} is not open")
        answers.append(IntakeAnswer(question=questions[index], answer=response.strip()))
    return answers


def ask_answers(report: IntakeReport) -> list[IntakeAnswer]:
    answers: list[IntakeAnswer] = []
    for number, question in enumerate(report.questions, start=1):
        response = input(f"{number}. {question} (Entrée = encore ouvert) : ").strip()
        if response:
            answers.append(IntakeAnswer(question=question, answer=response))
    return answers


def ask_route(report: IntakeReport) -> IntakeTriage | None:
    if report.triage != IntakeTriage.QUESTIONS:
        return None
    while True:
        response = input("Parcours [feature/patch/laisser ouvert] : ").strip().lower()
        if not response or response == "laisser ouvert":
            return None
        if response in {"feature", "patch"}:
            return IntakeTriage(response)
        print("Choisir feature, patch ou laisser ouvert.")


def print_report(feature_id: str, report: IntakeReport, revision: int) -> None:
    print(f"Demande {feature_id} · {report.triage.value} · {report.title} · révision {revision}")
    for number, question in enumerate(report.questions, start=1):
        print(f"À préciser {number} : {question}")
    if report.triage == IntakeTriage.FEATURE:
        print(f"Suite suggérée : cohorte brainstorm --from-intake {feature_id}")
    elif report.triage == IntakeTriage.PATCH:
        print(f"Suite suggérée : cohorte patch-spec --from-intake {feature_id}")
    else:
        print(f"Reprendre le triage : cohorte intake --continue {feature_id}")
