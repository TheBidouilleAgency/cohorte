from cohorte.adapters.git import path_is_owned


def test_path_ownership_requires_path_boundary() -> None:
    assert path_is_owned("src/module.py", ["src"])
    assert path_is_owned("src", ["src"])
    assert not path_is_owned("src-secret/file", ["src"])
