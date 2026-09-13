import type { Coco17KeypointId } from "../pose/types.js";
import type { FusedPersonMember, Vector3 } from "./types.js";

interface IdentityTrack {
  members: Set<string>;
  lastSequence: number;
  keypoints: Map<Coco17KeypointId, Vector3>;
}

const MAX_TRACKS = 32;

/**
 * Assigns stable `person-N` identifiers to camera/tracking-ID clusters and keeps
 * the last triangulated position of every keypoint so a momentarily unfused
 * keypoint can hold its previous value with a zero score.
 */
export class PersonIdentityRegistry {
  private readonly tracks = new Map<string, IdentityTrack>();
  private nextId = 1;

  public constructor(private readonly maxUnseenSequences = 30) {}

  public resolve(
    members: readonly FusedPersonMember[],
    sequence: number,
  ): string {
    const keys = members.map(memberKey);
    let bestId: string | undefined;
    let bestOverlap = 0;
    for (const [personId, track] of this.tracks) {
      if (track.lastSequence === sequence) continue;
      let overlap = 0;
      for (const key of keys) if (track.members.has(key)) overlap += 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = personId;
      }
    }
    const personId = bestId ?? this.createId();
    const track = this.tracks.get(personId) ?? {
      members: new Set<string>(),
      lastSequence: sequence,
      keypoints: new Map<Coco17KeypointId, Vector3>(),
    };
    track.members = new Set(keys);
    track.lastSequence = sequence;
    this.tracks.set(personId, track);
    return personId;
  }

  /** Tracks a cluster under an identifier the caller already resolved. */
  public adopt(
    personId: string,
    members: readonly FusedPersonMember[],
    sequence: number,
  ): string {
    const track = this.tracks.get(personId) ?? {
      members: new Set<string>(),
      lastSequence: sequence,
      keypoints: new Map<Coco17KeypointId, Vector3>(),
    };
    track.members = new Set(members.map(memberKey));
    track.lastSequence = sequence;
    this.tracks.set(personId, track);
    return personId;
  }

  public remember(
    personId: string,
    keypointId: Coco17KeypointId,
    point: Vector3,
  ): void {
    this.tracks.get(personId)?.keypoints.set(keypointId, point);
  }

  public lastPoint(
    personId: string,
    keypointId: Coco17KeypointId,
  ): Vector3 | undefined {
    return this.tracks.get(personId)?.keypoints.get(keypointId);
  }

  public prune(sequence: number): void {
    for (const [personId, track] of this.tracks) {
      if (sequence - track.lastSequence > this.maxUnseenSequences) {
        this.tracks.delete(personId);
      }
    }
    while (this.tracks.size > MAX_TRACKS) {
      const oldest = [...this.tracks.entries()].sort(
        (left, right) => left[1].lastSequence - right[1].lastSequence,
      )[0];
      if (!oldest) break;
      this.tracks.delete(oldest[0]);
    }
  }

  public clear(): void {
    this.tracks.clear();
    this.nextId = 1;
  }

  private createId(): string {
    const personId = `person-${this.nextId}`;
    this.nextId += 1;
    return personId;
  }
}

function memberKey(member: FusedPersonMember): string {
  return `${member.cameraId}/${member.trackingId}`;
}
