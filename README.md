# usage-band

Banda sobre el prompt de Claude Code con el uso de los límites, el contexto, el tiempo de vida del cache y los siguientes pasos sugeridos.

## Requisitos

**Claude Code 2.1.286 o superior.** El mod usa el evento `session.measure`, que no existe en versiones anteriores: allí `claude plugin validate` lo rechaza y el mod no carga. Compruébalo con:

```bash
claude --version
```

## Autor

Soulberto Lorenzo <slorenzot@gmail.com>

## Instalación

1. Descomprime el `.zip` en una carpeta fija, por ejemplo `~/.claude/mods/usage-band`.
2. Cárgalo en una sesión:

```bash
claude --plugin-dir ~/.claude/mods/usage-band
```

Para validarlo antes (requiere la versión 2.1.286 o superior):

```bash
claude plugin validate ~/.claude/mods/usage-band
```

## Licencia

[MIT](LICENSE) © 2026 Soulberto Lorenzo
