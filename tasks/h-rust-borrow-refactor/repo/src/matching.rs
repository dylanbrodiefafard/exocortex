use crate::book::OrderBook;
use crate::types::{BookError, Fill, Order, Price, Qty, Side, SubmitResult};

impl OrderBook {
    /// Submits a limit order for `owner`.
    ///
    /// The order first trades against resting orders on the opposite side
    /// whose price it crosses: best price first, oldest first within a price,
    /// each fill at the resting order's price. Fully filled resting orders
    /// leave the book; partially filled ones keep their place. Whatever is
    /// left of the incoming order then rests on the book.
    pub fn submit(
        &mut self,
        owner: &str,
        side: Side,
        price: Price,
        qty: Qty,
    ) -> Result<SubmitResult, BookError> {
        if qty == 0 {
            return Err(BookError::ZeroQuantity);
        }
        if price == 0 {
            return Err(BookError::ZeroPrice);
        }
        let id = self.allocate_id();
        let mut remaining = qty;
        let mut fills = Vec::new();
        let opposite = side.opposite();

        let levels = self.levels_mut(opposite);
        while remaining > 0 {
            let Some(best) = levels.best() else { break };
            if !side.crosses(price, best) {
                break;
            }
            let maker_id = levels.front(best);
            let index = self
                .orders
                .iter()
                .position(|order| order.id == maker_id)
                .expect("indexed order is resting");
            let maker = &mut self.orders[index];
            let traded = remaining.min(maker.qty);
            maker.qty -= traded;
            remaining -= traded;
            fills.push(Fill {
                maker: maker.id,
                taker: id,
                price: best,
                qty: traded,
            });
            if maker.qty == 0 {
                self.orders.remove(index);
                levels.pop_front(best);
            }
        }

        if remaining > 0 {
            let seq = self.next_seq();
            self.rest(Order {
                id,
                owner: owner.to_string(),
                side,
                price,
                qty: remaining,
                seq,
            });
        }
        Ok(SubmitResult {
            id,
            fills,
            resting: remaining,
        })
    }
}
