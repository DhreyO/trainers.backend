"""Trade reconciliation: returns sorted trade_ids from A that match B.

A trade matches iff B has exactly one record with the same trade_id
and |price_a - price_b| < tolerance (prices compared as exact decimals).
"""
from collections import Counter
from decimal import Decimal


def to_decimal(value):
    # str() first so 0.3 becomes Decimal("0.3"), not its binary approximation.
    return Decimal(str(value))


def reconcile(system_a, system_b, tolerance):
    tol = to_decimal(tolerance)
    if tol <= 0:
        raise ValueError("tolerance must be greater than 0")

    counts = Counter(trade_id for trade_id, _ in system_b)
    prices_b = {trade_id: to_decimal(price) for trade_id, price in system_b
                if counts[trade_id] == 1}

    return sorted(
        trade_id for trade_id, price in system_a
        if trade_id in prices_b and abs(to_decimal(price) - prices_b[trade_id]) < tol
    )


if __name__ == "__main__":
    system_a = [("T3", 1), ("T1", 1.05), ("T2", 9)]
    system_b = [("T1", 1), ("T2", 9), ("T2", 9), ("T3", 1.2), ("X", 0)]
    print(reconcile(system_a, system_b, 0.1))  # ['T1']
