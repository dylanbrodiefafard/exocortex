use std::collections::HashMap;

use crate::levels::PriceLevels;
use crate::types::{BookError, Order, OrderId, Price, Qty, Side};

/// Resting orders keyed by id, plus a per-side price-level index that holds
/// the time priority within each level.
#[derive(Clone, Debug)]
pub struct OrderBook {
    pub(crate) orders: HashMap<OrderId, Order>,
    pub(crate) bids: PriceLevels,
    pub(crate) asks: PriceLevels,
    next_id: OrderId,
    next_seq: u64,
}

impl Default for OrderBook {
    fn default() -> Self {
        Self::new()
    }
}

impl OrderBook {
    pub fn new() -> Self {
        OrderBook {
            orders: HashMap::new(),
            bids: PriceLevels::new(Side::Buy),
            asks: PriceLevels::new(Side::Sell),
            next_id: 1,
            next_seq: 0,
        }
    }

    /// Number of resting orders.
    pub fn len(&self) -> usize {
        self.orders.len()
    }

    pub fn is_empty(&self) -> bool {
        self.orders.is_empty()
    }

    pub fn get(&self, id: OrderId) -> Option<&Order> {
        self.orders.iter().find(|order| order.id == id)
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.best()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.best()
    }

    pub(crate) fn levels(&self, side: Side) -> &PriceLevels {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    pub(crate) fn levels_mut(&mut self, side: Side) -> &mut PriceLevels {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    pub(crate) fn allocate_id(&mut self) -> OrderId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub(crate) fn next_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// Adds `order` to the book behind every order already resting at its price.
    pub(crate) fn rest(&mut self, order: Order) {
        self.orders.push(order);
        self.levels_mut(order.side).push(order.price, order.id);
    }

    /// Removes a resting order and returns it with its remaining quantity.
    pub fn cancel(&mut self, id: OrderId) -> Result<Order, BookError> {
        let index = self
            .orders
            .iter()
            .position(|order| order.id == id)
            .ok_or(BookError::UnknownOrder(id))?;
        let order = self.orders.remove(index);
        self.levels_mut(order.side).remove(order.price, id);
        Ok(order)
    }

    /// Cancels every resting order that belongs to `owner` and returns them in
    /// time priority (lowest `seq` first).
    pub fn cancel_all(&mut self, owner: &str) -> Vec<Order> {
        let mut cancelled = Vec::new();
        for order in self.orders.iter() {
            if order.owner == owner {
                cancelled.push(self.cancel(order.id).unwrap());
            }
        }
        cancelled
    }

    /// Changes the open quantity of a resting order. Reducing it keeps the
    /// order's time priority; increasing it sends the order to the back of its
    /// price level.
    pub fn amend(&mut self, id: OrderId, new_qty: Qty) -> Result<(), BookError> {
        if new_qty == 0 {
            return Err(BookError::ZeroQuantity);
        }
        let order = self.orders.get_mut(&id).ok_or(BookError::UnknownOrder(id))?;
        if new_qty > order.qty {
            let levels = self.levels_mut(order.side);
            levels.remove(order.price, id);
            levels.push(order.price, id);
            order.seq = self.next_seq();
        }
        order.qty = new_qty;
        Ok(())
    }
}
