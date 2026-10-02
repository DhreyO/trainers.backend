"""Two-sided order book: apply update events, return [best_bid, best_ask].

Each event is (side, price, quantity):
  - quantity == 0 removes that price level (no-op if the level isn't there);
  - otherwise the level is set to quantity (new level or replacement).
best_bid is the highest active bid, best_ask the lowest active ask, or None.
"""


def best_bid_ask(events):
    book = {"BID": {}, "ASK": {}}

    for side, price, quantity in events:
        if side not in book:
            raise ValueError(f"side must be 'BID' or 'ASK', got {side!r}")
        levels = book[side]
        if quantity == 0:
            levels.pop(price, None)
        else:
            levels[price] = quantity

    best_bid = max(book["BID"]) if book["BID"] else None
    best_ask = min(book["ASK"]) if book["ASK"] else None
    return [best_bid, best_ask]


if __name__ == "__main__":
    events = [
        ("BID", 100.0, 5),
        ("BID", 101.5, 2),
        ("ASK", 103.0, 4),
        ("ASK", 102.0, 1),
        ("BID", 101.5, 0),  # remove the best bid
        ("ASK", 102.0, 3),  # replace quantity, still best ask
        ("ASK", 99.0, 0),   # not in the book: no-op
    ]
    print(best_bid_ask(events))  # [100.0, 102.0]
