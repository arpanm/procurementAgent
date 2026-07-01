package ai.procurecopilot.backend.knowledge;

import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data repository for the persisted live knowledge doc, keyed by platform wire string. */
public interface KnowledgeDocRepository extends JpaRepository<KnowledgeDocEntity, String> {}
