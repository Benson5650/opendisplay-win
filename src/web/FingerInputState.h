#pragma once

#include "CoordinateMapper.h"
#include <algorithm>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <vector>

namespace od::web {

enum class DirectTouchPhase { Down, Move, Up, Cancel };
enum class DirectTouchChange { Down, Update, Up, Cancel };

struct DirectTouchContact {
    uint32_t sourceId{};
    uint32_t pointerId{};
    Point position{};
    DirectTouchChange change = DirectTouchChange::Update;
};

// Converts independent browser PointerEvents into complete Windows touch
// frames. Windows needs stable, small pointer IDs and every still-active
// contact must accompany the contact that changed.
class DirectTouchState {
public:
    static constexpr size_t MaxContacts = 5;

    std::optional<std::vector<DirectTouchContact>> Apply(
        uint32_t sourceId, DirectTouchPhase phase, std::optional<Point> position)
    {
        auto existing = contacts_.find(sourceId);
        if (phase == DirectTouchPhase::Down) {
            if (existing != contacts_.end() || !position || contacts_.size() >= MaxContacts)
                return std::nullopt;
            Contact contact{AllocatePointerId(), *position};
            contacts_.emplace(sourceId, contact);
            return Frame(sourceId, DirectTouchChange::Down, contact.position, false);
        }
        if (existing == contacts_.end()) return std::nullopt;
        if (phase == DirectTouchPhase::Move) {
            if (!position) return std::nullopt;
            existing->second.position = *position;
            return Frame(sourceId, DirectTouchChange::Update, *position, false);
        }
        const auto finalPosition = existing->second.position; // Windows UP must reuse the last UPDATE point.
        return Frame(sourceId,
            phase == DirectTouchPhase::Cancel ? DirectTouchChange::Cancel : DirectTouchChange::Up,
            finalPosition, true);
    }

    std::vector<DirectTouchContact> CancelAll()
    {
        std::vector<DirectTouchContact> frame;
        frame.reserve(contacts_.size());
        for (const auto& [sourceId, contact] : contacts_)
            frame.push_back({sourceId, contact.pointerId, contact.position, DirectTouchChange::Cancel});
        contacts_.clear();
        Sort(frame);
        return frame;
    }

    size_t Size() const { return contacts_.size(); }

private:
    struct Contact { uint32_t pointerId; Point position; };

    uint32_t AllocatePointerId() const
    {
        for (uint32_t candidate = 1; candidate <= MaxContacts; ++candidate) {
            bool used = false;
            for (const auto& [_, contact] : contacts_)
                if (contact.pointerId == candidate) { used = true; break; }
            if (!used) return candidate;
        }
        return 0;
    }

    std::vector<DirectTouchContact> Frame(uint32_t changedId, DirectTouchChange change,
                                          Point changedPosition, bool removeAfter)
    {
        std::vector<DirectTouchContact> frame;
        frame.reserve(contacts_.size());
        for (const auto& [sourceId, contact] : contacts_) {
            frame.push_back({sourceId, contact.pointerId,
                sourceId == changedId ? changedPosition : contact.position,
                sourceId == changedId ? change : DirectTouchChange::Update});
        }
        if (removeAfter) contacts_.erase(changedId);
        Sort(frame);
        return frame;
    }

    static void Sort(std::vector<DirectTouchContact>& frame)
    {
        std::ranges::sort(frame, {}, &DirectTouchContact::pointerId);
    }

    std::unordered_map<uint32_t, Contact> contacts_;
};

} // namespace od::web
