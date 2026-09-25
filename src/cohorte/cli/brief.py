from __future__ import annotations

from cohorte.application.preparation import BrainstormBrief


def _items(label: str, values: list[str]) -> None:
    if values:
        print(f"{label} :")
        for value in values:
            print(f"  • {value}")


def print_brief(brief: BrainstormBrief, revision: int) -> None:
    synthesis = brief.synthesis
    print(f"Brief {brief.feature_id} · révision {revision}")
    if brief.previous_brief_ref is not None:
        print(f"Suite de la révision {brief.previous_brief_ref.revision}")
    print(f"Idée : {brief.idea}")
    _items("Réponses fournies", brief.user_answers)
    _items("Décisions antérieures", brief.prior_decisions)
    _items("Décisions de l'utilisateur", brief.decisions)
    if brief.project_context:
        print(f"Contexte du projet : {brief.project_context}")
    print(f"\nSynthèse\nProblème : {synthesis.problem}")
    print(f"Piste du panel (pas une décision) : {synthesis.recommendation}")
    for label, values in (
        ("Bénéficiaires", synthesis.beneficiaries),
        ("Dans le périmètre", synthesis.in_scope),
        ("Hors périmètre", synthesis.out_of_scope),
        ("Options", synthesis.options),
        ("Objections fortes", synthesis.strong_objections),
        ("Divergences", synthesis.divergences),
        ("Questions à trancher", synthesis.blocking_questions),
        ("Autres questions", synthesis.non_blocking_questions),
        ("Pistes de critères", synthesis.criterion_leads),
    ):
        _items(label, values)
    if synthesis.question_proposals:
        print("Propositions du panel (à valider) :")
        for proposal in synthesis.question_proposals:
            print(f"  • {proposal.question}")
            print(f"    Produit : {proposal.business_option}")
            print(f"    Code : {proposal.code_option}")
            print(f"    À vérifier : {proposal.caveat}")
    for contribution in brief.contributions:
        print(f"\nPerspective {contribution.perspective}")
        print(f"Problème : {contribution.problem}")
        for label, values in (
            ("Hypothèses", contribution.assumptions),
            ("Alternatives", contribution.alternatives),
            ("Risques", contribution.risks),
            ("Questions", contribution.questions),
            ("Désaccords", contribution.disagreements),
        ):
            _items(label, values)
