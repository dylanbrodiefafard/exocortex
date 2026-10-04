use orderbook::{BookError, Fill, Level, OrderBook, Side};

fn fill(maker: u64, taker: u64, price: u64, qty: u64) -> Fill {
    Fill { maker, taker, price, qty }
}

#[test]
fn resting_orders_are_visible() {
    let mut book = OrderBook::new();
    let bid = book.submit("alice", Side::Buy, 100, 5).unwrap();
    let ask = book.submit("bob", Side::Sell, 103, 7).unwrap();
    assert!(bid.fills.is_empty());
    assert_eq!(bid.resting, 5);
    assert_eq!(book.len(), 2);
    assert_eq!(book.best_bid(), Some(100));
    assert_eq!(book.best_ask(), Some(103));
    assert_eq!(book.spread(), Some(3));
    let order = book.get(ask.id).unwrap();
    assert_eq!((order.owner.as_str(), order.side, order.price, order.qty), ("bob", Side::Sell, 103, 7));
    assert!(book.get(999).is_none());
}

#[test]
fn rejects_zero_quantity_and_price() {
    let mut book = OrderBook::new();
    assert_eq!(book.submit("a", Side::Buy, 100, 0), Err(BookError::ZeroQuantity));
    assert_eq!(book.submit("a", Side::Buy, 0, 1), Err(BookError::ZeroPrice));
    assert!(book.is_empty());
}

#[test]
fn full_fill_removes_maker() {
    let mut book = OrderBook::new();
    let maker = book.submit("alice", Side::Sell, 101, 4).unwrap();
    let taker = book.submit("bob", Side::Buy, 101, 4).unwrap();
    assert_eq!(taker.fills, vec![fill(maker.id, taker.id, 101, 4)]);
    assert_eq!(taker.resting, 0);
    assert!(book.is_empty());
    assert_eq!(book.best_ask(), None);
    assert!(book.get(maker.id).is_none());
}

#[test]
fn partial_fill_reduces_maker_in_place() {
    let mut book = OrderBook::new();
    let first = book.submit("alice", Side::Sell, 101, 10).unwrap();
    let second = book.submit("carol", Side::Sell, 101, 3).unwrap();
    let taker = book.submit("bob", Side::Buy, 105, 4).unwrap();
    assert_eq!(taker.fills, vec![fill(first.id, taker.id, 101, 4)]);
    assert_eq!(book.get(first.id).unwrap().qty, 6);
    assert_eq!(book.depth(Side::Sell, 5), vec![Level { price: 101, qty: 9, orders: 2 }]);

    // The partially filled order keeps its place at the front of the level.
    let taker = book.submit("bob", Side::Buy, 101, 7).unwrap();
    assert_eq!(
        taker.fills,
        vec![fill(first.id, taker.id, 101, 6), fill(second.id, taker.id, 101, 1)]
    );
    assert_eq!(book.get(second.id).unwrap().qty, 2);
    assert!(book.get(first.id).is_none());
}

#[test]
fn sweeps_levels_best_price_first_at_maker_prices() {
    let mut book = OrderBook::new();
    let a = book.submit("m1", Side::Sell, 103, 2).unwrap();
    let b = book.submit("m2", Side::Sell, 101, 2).unwrap();
    let c = book.submit("m3", Side::Sell, 102, 2).unwrap();
    let d = book.submit("m4", Side::Sell, 101, 2).unwrap();
    let taker = book.submit("t", Side::Buy, 102, 7).unwrap();
    assert_eq!(
        taker.fills,
        vec![
            fill(b.id, taker.id, 101, 2),
            fill(d.id, taker.id, 101, 2),
            fill(c.id, taker.id, 102, 2),
        ]
    );
    assert_eq!(taker.resting, 1);
    assert_eq!(book.best_bid(), Some(102));
    assert_eq!(book.best_ask(), Some(103));
    assert_eq!(book.get(a.id).unwrap().qty, 2);
    assert_eq!(book.get(taker.id).unwrap().qty, 1);
}

#[test]
fn sell_side_taker_matches_highest_bid_first() {
    let mut book = OrderBook::new();
    let low = book.submit("m1", Side::Buy, 98, 5).unwrap();
    let high = book.submit("m2", Side::Buy, 99, 5).unwrap();
    let taker = book.submit("t", Side::Sell, 98, 8).unwrap();
    assert_eq!(
        taker.fills,
        vec![fill(high.id, taker.id, 99, 5), fill(low.id, taker.id, 98, 3)]
    );
    assert_eq!(book.depth(Side::Buy, 10), vec![Level { price: 98, qty: 2, orders: 1 }]);
}

#[test]
fn cancel_removes_order_from_book_and_matching() {
    let mut book = OrderBook::new();
    let a = book.submit("alice", Side::Sell, 101, 5).unwrap();
    let b = book.submit("bob", Side::Sell, 101, 5).unwrap();
    let cancelled = book.cancel(a.id).unwrap();
    assert_eq!((cancelled.id, cancelled.qty), (a.id, 5));
    assert!(book.get(a.id).is_none());
    assert_eq!(book.cancel(a.id), Err(BookError::UnknownOrder(a.id)));
    assert_eq!(book.depth(Side::Sell, 5), vec![Level { price: 101, qty: 5, orders: 1 }]);

    let taker = book.submit("carol", Side::Buy, 101, 3).unwrap();
    assert_eq!(taker.fills, vec![fill(b.id, taker.id, 101, 3)]);
}

#[test]
fn cancel_all_returns_owner_orders_in_submission_order() {
    let mut book = OrderBook::new();
    let mut alice = Vec::new();
    for (i, price) in [105u64, 101, 103, 102, 104, 101].into_iter().enumerate() {
        alice.push(book.submit("alice", Side::Sell, price, 1 + i as u64).unwrap().id);
        book.submit("bob", Side::Sell, price, 10).unwrap();
    }
    let bob_first_at_101 = book.orders_for("bob")[1].id;

    let cancelled = book.cancel_all("alice");
    assert_eq!(cancelled.iter().map(|o| o.id).collect::<Vec<_>>(), alice);
    assert!(book.orders_for("alice").is_empty());
    assert!(book.cancel_all("alice").is_empty());
    assert_eq!(book.len(), 6);
    assert_eq!(book.open_qty(Side::Sell), 60);

    let taker = book.submit("carol", Side::Buy, 101, 25).unwrap();
    assert_eq!(taker.fills.len(), 2);
    assert_eq!(taker.resting, 5);
    assert_eq!(taker.fills[0], fill(bob_first_at_101, taker.id, 101, 10));
    assert!(taker.fills.iter().all(|f| !alice.contains(&f.maker)));
    assert_eq!(book.depth(Side::Sell, 1), vec![Level { price: 102, qty: 10, orders: 1 }]);
}

#[test]
fn amend_down_keeps_priority() {
    let mut book = OrderBook::new();
    let a = book.submit("alice", Side::Buy, 100, 10).unwrap();
    let b = book.submit("bob", Side::Buy, 100, 10).unwrap();
    book.amend(a.id, 4).unwrap();
    assert_eq!(book.get(a.id).unwrap().qty, 4);
    assert_eq!(book.open_qty(Side::Buy), 14);
    let taker = book.submit("t", Side::Sell, 100, 6).unwrap();
    assert_eq!(
        taker.fills,
        vec![fill(a.id, taker.id, 100, 4), fill(b.id, taker.id, 100, 2)]
    );
}

#[test]
fn amend_up_loses_priority() {
    let mut book = OrderBook::new();
    let a = book.submit("alice", Side::Buy, 100, 2).unwrap();
    let b = book.submit("bob", Side::Buy, 100, 3).unwrap();
    let seq_before = book.get(a.id).unwrap().seq;
    book.amend(a.id, 6).unwrap();
    let amended = book.get(a.id).unwrap();
    assert_eq!(amended.qty, 6);
    assert!(amended.seq > seq_before);
    assert_eq!(book.depth(Side::Buy, 1), vec![Level { price: 100, qty: 9, orders: 2 }]);
    assert_eq!(
        book.orders_for("alice").iter().map(|o| o.qty).collect::<Vec<_>>(),
        vec![6]
    );
    let taker = book.submit("t", Side::Sell, 100, 5).unwrap();
    assert_eq!(
        taker.fills,
        vec![fill(b.id, taker.id, 100, 3), fill(a.id, taker.id, 100, 2)]
    );
    assert_eq!(book.get(a.id).unwrap().qty, 4);
}

#[test]
fn amend_errors() {
    let mut book = OrderBook::new();
    let a = book.submit("alice", Side::Buy, 100, 2).unwrap();
    assert_eq!(book.amend(a.id, 0), Err(BookError::ZeroQuantity));
    assert_eq!(book.amend(77, 3), Err(BookError::UnknownOrder(77)));
    assert_eq!(book.get(a.id).unwrap().qty, 2);
}

#[test]
fn depth_aggregates_and_limits_levels() {
    let mut book = OrderBook::new();
    book.submit("a", Side::Buy, 97, 1).unwrap();
    book.submit("b", Side::Buy, 99, 2).unwrap();
    book.submit("c", Side::Buy, 98, 3).unwrap();
    book.submit("d", Side::Buy, 99, 4).unwrap();
    book.submit("e", Side::Sell, 120, 1).unwrap();
    assert_eq!(
        book.depth(Side::Buy, 2),
        vec![Level { price: 99, qty: 6, orders: 2 }, Level { price: 98, qty: 3, orders: 1 }]
    );
    assert_eq!(book.depth(Side::Buy, 10).len(), 3);
    assert_eq!(book.open_qty(Side::Buy), 10);
    assert_eq!(book.open_qty(Side::Sell), 1);
}

#[test]
fn orders_for_lists_owner_orders_in_time_priority() {
    let mut book = OrderBook::new();
    let mut expected = Vec::new();
    for (i, price) in [90u64, 95, 91, 94, 92, 93, 96].into_iter().enumerate() {
        expected.push(book.submit("alice", Side::Buy, price, 1 + i as u64).unwrap().id);
        book.submit("bob", Side::Buy, price, 1).unwrap();
    }
    let ids: Vec<u64> = book.orders_for("alice").iter().map(|o| o.id).collect();
    assert_eq!(ids, expected);
    assert_eq!(book.orders_for("nobody").len(), 0);
}
