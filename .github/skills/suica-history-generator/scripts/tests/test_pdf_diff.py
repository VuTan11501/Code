"""Tests for pdf_diff using two trivial PDFs generated on the fly."""
from __future__ import annotations

from pathlib import Path

import pytest

from scripts.pdf_diff import pixel_diff, structural_diff


def _make_pdf(path: Path, text: str) -> None:
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    page = doc.new_page(width=400, height=600)
    page.insert_text((50, 100), text, fontsize=14)
    doc.save(str(path))
    doc.close()


def test_pixel_diff_identical(tmp_path: Path):
    pytest.importorskip("fitz")
    pytest.importorskip("PIL")
    pytest.importorskip("numpy")
    a = tmp_path / "a.pdf"
    b = tmp_path / "b.pdf"
    _make_pdf(a, "hello world")
    _make_pdf(b, "hello world")
    report = pixel_diff(a, b, dpi=72, threshold=0.99)
    assert report.passes
    assert report.overall_similarity >= 0.99
    assert report.mode == "pixel"
    assert len(report.pages) == 1


def test_pixel_diff_different(tmp_path: Path):
    pytest.importorskip("fitz")
    pytest.importorskip("PIL")
    pytest.importorskip("numpy")
    a = tmp_path / "a.pdf"
    b = tmp_path / "b.pdf"
    _make_pdf(a, "AAAAAAAA")
    _make_pdf(b, "ZZZZZZZZ")
    report = pixel_diff(a, b, dpi=72, threshold=0.999)
    # Both are mostly white pages, so similarity is high BUT text region differs.
    # Make sure the diff did detect the changed pixels.
    assert report.pages[0].px_above_thresh > 0


def test_structural_diff_identical(tmp_path: Path):
    pytest.importorskip("fitz")
    a = tmp_path / "a.pdf"
    b = tmp_path / "b.pdf"
    _make_pdf(a, "hello world")
    _make_pdf(b, "hello world")
    report = structural_diff(a, b, threshold=0.95)
    assert report.passes
    assert report.mode == "structural"


def test_structural_diff_different_span_count(tmp_path: Path):
    pytest.importorskip("fitz")
    a = tmp_path / "a.pdf"
    b = tmp_path / "b.pdf"
    _make_pdf(a, "one")
    # Two text inserts -> different span count
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=400, height=600)
    page.insert_text((50, 100), "one", fontsize=14)
    page.insert_text((50, 130), "two", fontsize=14)
    doc.save(str(b))
    doc.close()
    report = structural_diff(a, b, threshold=0.99)
    # 1 vs 2 spans -> span_sim = 0.5, fonts identical -> 1.0, avg = 0.75
    assert report.overall_similarity < 0.99
    assert not report.passes
