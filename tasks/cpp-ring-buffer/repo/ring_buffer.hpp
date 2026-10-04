#pragma once

#include <cstddef>
#include <optional>
#include <vector>

// Fixed-capacity FIFO queue. When full, push() overwrites the oldest element.
template <typename T>
class RingBuffer {
public:
    explicit RingBuffer(std::size_t capacity) : data_(capacity), head_(0), size_(0) {}

    void push(const T& value) {
        std::size_t tail = head_ + size_;
        data_[tail] = value;
        if (size_ < data_.size()) {
            ++size_;
        }
    }

    // Removes and returns the oldest element, or nothing when empty.
    std::optional<T> pop() {
        if (size_ == 0) {
            return std::nullopt;
        }
        T value = data_[head_];
        head_ = head_ + 1;
        --size_;
        return value;
    }

    std::size_t size() const { return size_; }
    std::size_t capacity() const { return data_.size(); }
    bool empty() const { return size_ == 0; }

private:
    std::vector<T> data_;
    std::size_t head_;
    std::size_t size_;
};
