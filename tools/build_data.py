#!/usr/bin/env python3
"""Packs the PMP (Pokedex5E) data into the few JSON files the extension loads.

Run it again whenever the app's data changes:
    python tools/build_data.py "C:/caminho/para/Pokedex5E-master"

Output (in ../data):
    moves.json    every move, keyed by its file name (the name the app stores in a Pokémon's "moves")
    pokemon.json  every species, without the move lists (not needed to play)
    rules.json    leveling table (proficiency/STAB per level) and natures
"""
import json
import sys
from pathlib import Path

DEFAULT_APP = Path(r"C:\Users\Keven\Documents\.Pokemon RPG #############\PMP\Pokedex5E-master")
SPECIES_KEEP = ("AC", "HP", "Hit Dice", "Type", "attributes", "saving_throws", "Abilities", "Hidden Ability",
                "Skill", "Senses", "size", "index", "SR", "MIN LVL FD", "variant_data",
                # speeds in feet, same keys as the app's pokedex.get_*_speed
                "WSp", "Fsp", "Ssp", "Climbing Speed", "Burrowing Speed")


def load(path):
    # strict=False: some app files have raw tabs/line breaks inside strings
    return json.loads(Path(path).read_text(encoding="utf-8"), strict=False)


def main():
    app = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_APP
    data = app / "p5e-data" / "data"
    out = Path(__file__).resolve().parent.parent / "data"
    out.mkdir(exist_ok=True)

    moves = {f.stem: load(f) for f in sorted((data / "moves").glob("*.json"))}
    error_move = app / "assets" / "datafiles" / "Error_move.json"
    if error_move.exists():
        moves.setdefault("Error", load(error_move))

    pokemon = {}
    for f in sorted((data / "pokemon").glob("*.json")):
        raw = load(f)
        pokemon[f.stem] = {k: raw[k] for k in SPECIES_KEEP if k in raw}

    rules = {
        "leveling": load(app / "assets" / "datafiles" / "leveling.json"),
        "natures": load(app / "assets" / "datafiles" / "natures.json"),
        # descriptions shown on the sheet (talentos and habilidades)
        "feats": {k: v.get("Description", "") for k, v in load(app / "assets" / "datafiles" / "feats.json").items()},
        "abilities": {k: (v.get("Description", "") if isinstance(v, dict) else str(v))
                      for k, v in load(data / "abilities.json").items()},
    }

    for name, obj in (("moves", moves), ("pokemon", pokemon), ("rules", rules)):
        target = out / f"{name}.json"
        target.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{target.name}: {len(obj)} entradas, {target.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
