use crate::book::OrderBook;
use crate::types::{Order, Price, Qty, Side};

/// One aggregated price level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Level {
    pub price: Price,
    pub qty: Qty,
    pub orders: usize,
}

impl OrderBook {
    /// Aggregated depth on `side`, best price first, at most `max_levels` levels.
    pub fn depth(&self, side: Side, max_levels: usize) -> Vec<Level> {
        let mut levels: Vec<Level> = Vec::new();
        for (price, queue) in self.levels(side).iter_best_first().take(max_levels) {
            let mut level = Level { price, qty: 0, orders: 0 };
            for id in queue {
                let order = self.orders.iter().find(|order| order.id == *id).unwrap();
                level.qty += order.qty;
                level.orders += 1;
            }
            levels.push(level);
        }
        levels
    }

    /// Total open quantity resting on `side`.
    pub fn open_qty(&self, side: Side) -> Qty {
        self.orders
            .iter()
            .filter(|order| order.side == side)
            .map(|order| order.qty)
            .sum()
    }

    /// Resting orders that belong to `owner`, in time priority (lowest `seq` first).
    pub fn orders_for(&self, owner: &str) -> Vec<&Order> {
        self.orders
            .iter()
            .filter(|order| order.owner == owner)
            .collect()
    }

    /// Best ask minus best bid, if both sides have orders.
    pub fn spread(&self) -> Option<Price> {
        Some(self.best_ask()? - self.best_bid()?)
    }
}
