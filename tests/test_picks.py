"""Sanity checks for the recommendation model's building blocks."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import picks


def test_outlook_is_ordered_and_bounded():
    for vol in (0.1, 0.3, 0.8, 1.5):
        for h in picks.HORIZONS:
            o = picks.outlook(vol, h)
            assert o["lo"] < o["mid"] < o["hi"], (vol, h, o)
            assert o["lo"] > -1.0, "a long position cannot lose more than 100%"
            assert 0 < o["p_up"] < 1


def test_more_volatility_means_wider_band_and_lower_win_chance():
    calm, wild = picks.outlook(0.2, 126), picks.outlook(0.8, 126)
    assert wild["hi"] - wild["lo"] > calm["hi"] - calm["lo"]
    assert wild["p_up"] < calm["p_up"]


def test_longer_horizon_is_wider():
    a, b = picks.outlook(0.3, 21), picks.outlook(0.3, 126)
    assert b["hi"] - b["lo"] > a["hi"] - a["lo"]


if __name__ == "__main__":
    test_outlook_is_ordered_and_bounded(); test_more_volatility_means_wider_band_and_lower_win_chance()
    test_longer_horizon_is_wider(); print("picks tests OK")
