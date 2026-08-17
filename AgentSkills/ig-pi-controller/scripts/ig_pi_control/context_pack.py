"""Context Pack creation, integrity checks, and version advancement."""

from __future__ import annotations

from hashlib import sha256
import json

from .models import ContextPack, ResearchMaterial, SourceFact


def compute_digest(pack: ContextPack) -> str:
    payload = pack.model_dump(mode="json", by_alias=True, exclude={"digest"})
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{sha256(canonical.encode('utf-8')).hexdigest()}"


def finalize_context_pack(pack: ContextPack) -> ContextPack:
    digest = compute_digest(pack)
    if pack.digest is not None and pack.digest != digest:
        raise ValueError("contextPack digest does not match its contents")
    return pack.model_copy(update={"digest": digest})


def create_context_pack(goal: str) -> ContextPack:
    return finalize_context_pack(ContextPack(version="cp-0001", goal=goal))


def advance_context_pack(pack: ContextPack, materials: list[ResearchMaterial]) -> ContextPack:
    prefix, sequence = pack.version.rsplit("-", maxsplit=1)
    next_version = f"{prefix}-{int(sequence) + 1:04d}"
    facts = list(pack.known_facts)
    existing = {(fact.source_ref, fact.text) for fact in facts}
    for material in materials:
        fact = SourceFact(
            text=material.excerpt,
            sourceRef=material.source_ref,
            scope=material.time_range,
        )
        key = (fact.source_ref, fact.text)
        if key not in existing:
            facts.append(fact)
            existing.add(key)
    return finalize_context_pack(
        pack.model_copy(update={"version": next_version, "known_facts": facts, "digest": None})
    )
