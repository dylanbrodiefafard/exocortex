use std::collections::{BTreeMap, VecDeque};

use crate::types::{OrderId, Price, Side};

/// Order ids on one side of the book, grouped by price level. Within a level
/// the queue is in time priority (front = oldest).
#[derive(Clone, Debug)]
pub struct PriceLevels {
    side: Side,
    levels: BTreeMap<Price, VecDeque<OrderId>>,
}

impl PriceLevels {
    pub fn new(side: Side) -> Self {
        PriceLevels {
            side,
            levels: BTreeMap::new(),
        }
    }

    pub fn push(&mut self, price: Price, id: OrderId) {
        self.levels.entry(price).or_default().push_back(id);
    }

    /// Removes `id` from the level at `price`. Returns false if it was not there.
    pub fn remove(&mut self, price: Price, id: OrderId) -> bool {
        let Some(queue) = self.levels.get_mut(&price) else {
            return false;
        };
        let Some(pos) = queue.iter().position(|&queued| queued == id) else {
            return false;
        };
        queue.remove(pos);
        if queue.is_empty() {
            self.levels.remove(&price);
        }
        true
    }

    /// Best price on this side: highest bid or lowest ask.
    pub fn best(&self) -> Option<Price> {
        match self.side {
            Side::Buy => self.levels.keys().next_back().copied(),
            Side::Sell => self.levels.keys().next().copied(),
        }
    }

    pub fn front(&self, price: Price) -> Option<OrderId> {
        self.levels.get(&price).and_then(|queue| queue.front().copied())
    }

    pub fn pop_front(&mut self, price: Price) -> Option<OrderId> {
        let queue = self.levels.get_mut(&price)?;
        let id = queue.pop_front();
        if queue.is_empty() {
            self.levels.remove(&price);
        }
        id
    }

    /// Levels from best to worst price, each with its queue.
    pub fn iter_best_first(&self) -> Box<dyn Iterator<Item = (Price, &VecDeque<OrderId>)> + '_> {
        let iter = self.levels.iter().map(|(&price, queue)| (price, queue));
        match self.side {
            Side::Buy => Box::new(iter.rev()),
            Side::Sell => Box::new(iter),
        }
    }
}
