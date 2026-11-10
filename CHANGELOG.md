# Journal des modifications

Ce projet suit [Semantic Versioning](https://semver.org/lang/fr/). Le contrat JSON a sa propre version (`schemaVersion`).

## [Non publié]

## [0.1.0] - 2026-11-10

### Ajouté

- Commandes `init`, `add`, `install`, `list`, `outdated`, `update`, `remove`, `search`, `info`, `scan`, `registry add|list|remove|export`, `version`.
- Contrat JSON 1.0 (`schemas/cli-output.v1.schema.json`), validé par les tests sur chaque commande.
- Installation en deux temps : `--dry-run` puis `--yes --expect-plan <planHash>`.
- Client TypeScript sans dépendance (`@agenteca/cli/client`).
- Test d'interopérabilité avec `apm` 0.35.0.
